import Twig from "twig"
import { join, resolve, dirname } from "node:path"
import { existsSync, readdirSync } from "node:fs"
import { normalizePath } from "vite"

const { twig } = Twig

const FRAMEWORK_REACT = "react"
const FRAMEWORK_HTML = "html"

const defaultOptions = {
  namespaces: {},
  filters: {},
  functions: {},
  globalContext: {},
  framework: FRAMEWORK_HTML,
  pattern: /\.(twig)(\?.*)?$/,
}
Twig.cache(false)

const includeTokenTypes = [
  "Twig.logic.type.embed",
  "Twig.logic.type.include",
  "Twig.logic.type.extends",
  "Twig.logic.type.import",
]

const findInChildDirectories = (directory, component) => {
  const files = readdirSync(directory, { recursive: true })
  for (const file of files) {
    const filePath = join(directory, file)
    if (file.endsWith(`/${component}.twig`)) {
      return filePath
    }
  }

  return null
}

// Scan a directory for .twig files
const findIncludesInDir = (searchPath, originalBasePath) => {
  try {
    if (!existsSync(searchPath)) {
      return []
    }

    const files = readdirSync(searchPath, { withFileTypes: true })
    return files
      .filter(file => file.isFile() && file.name.endsWith('.twig'))
      .map(file => {
        return join(originalBasePath, file.name).replace(/\\/g, '/')
      })
  } catch (e) {
    console.warn(`Could not scan directory for dynamic includes: ${searchPath}`, e.message);
    return [];
  }
}

const resolveFile = (directory, file) => {
  const filesToTry = [file, `${file}.twig`, `${file}.html.twig`]
  for (const ix in filesToTry) {
    const path = resolve(filesToTry[ix])
    if (existsSync(path)) {
      return normalizePath(path)
    }
    const withDir = resolve(directory, filesToTry[ix])
    if (existsSync(withDir)) {
      return normalizePath(withDir)
    }
  }

  return normalizePath(resolve(directory, file))
}

// Check if a sequence of tokens matches the 'string' ~ variable pattern
const isConcatenationPattern = (stack, index) => {
  const current = stack[index]
  const next = stack[index + 1]
  const operator = stack[index + 2]

  return (
    current?.type === 'Twig.expression.type.string' &&
    next?.type === 'Twig.expression.type.variable' &&
    operator?.type === 'Twig.expression.type.operator.binary' &&
    operator?.value === '~'
  )
}

// Analyze a token's expression stack to find concatenation patterns, and
// resolve potential file paths from dynamic includes
const analyzeDynamicIncludes = (stack, baseDirectory, namespaces) => {
  if (!stack || stack.length < 3) return []

  const potentialIncludes = []

  // Look for concatenation patterns: string + variable + ~ operator
  for (let i = 0; i < stack.length - 2; i++) {
    if (isConcatenationPattern(stack, i)) {
      const basePath = stack[i].value

      let searchPath
      if (basePath.startsWith('@') || basePath.includes(':')) {
        searchPath = resolveNamespaceOrComponent(namespaces, basePath)
      } else {
        searchPath = resolve(baseDirectory, basePath)
      }

      if (searchPath) {
        const foundIncludes = findIncludesInDir(searchPath, basePath)
        potentialIncludes.push(...foundIncludes)
      }
    }
  }

  return potentialIncludes
}

const pluckIncludes = (tokens, baseDirectory = '', namespaces = {}) => {
  const allIncludes = tokens.flatMap(token => {
    const includes = []

    if (includeTokenTypes.includes(token.token?.type)) {
      const stack = token.token.stack || []
      const hasConcatenation = stack.some(
        item => item.type === 'Twig.expression.type.operator.binary' && item.value === '~'
      )

      if (hasConcatenation) {
        includes.push(...analyzeDynamicIncludes(stack, baseDirectory, namespaces))
      } else {
        const staticPaths = stack
          .filter(item => item.type === 'Twig.expression.type.string')
          .map(item => item.value)
        includes.push(...staticPaths)
      }
    }

    const nestedTokens = token.token?.output || []
    if (nestedTokens.length > 0) {
      includes.push(...pluckIncludes(nestedTokens, baseDirectory, namespaces))
    }

    return includes
  })

  return [...new Set(allIncludes)]
}

const resolveNamespaceOrComponent = (namespaces, template) => {
  let resolveTemplate = template
  const isNamespace = template.includes(":")

  // Support for SDC.
  if (isNamespace) {
    const [namespace, component] = template.split(":")
    resolveTemplate = `@${namespace}/${component}/${component}`
  }
  let expandedPath = Twig.path.expandNamespace(namespaces, resolveTemplate)

  // If file not found and we are in namespace -> search deeper.
  if (!existsSync(expandedPath) && isNamespace) {
    const [namespace, component] = template.split(":")
    let foundFile = findInChildDirectories(namespaces[namespace], component)
    if (existsSync(foundFile)) {
      expandedPath = foundFile
    }
  }

  return expandedPath
}

const compileTemplate = (id, file, { namespaces }) => {
  return new Promise((resolve, reject) => {
    const options = { namespaces, rethrow: true, allowInlineIncludes: true }
    twig({
      id,
      path: file,
      error: reject,
      allowInlineIncludes: true,
      load(template) {
        if (typeof template.tokens === "undefined") {
          reject("Error compiling twig file")
          return
        }
        resolve({
          includes: pluckIncludes(template.tokens, dirname(file), namespaces),
          code: template.compile(options),
        })
      },
    })
  })
}

Twig.cache(false)

const errorHandler =
  (id, isDefault = true) =>
  (e) => {
    if (isDefault) {
      return {
        code: `export default () => 'An error occurred whilst rendering ${id}: ${e.toString()} ${
          e.stack
        }';`,
        map: null,
      }
    }
    return {
      code: null,
      map: null,
    }
  }

const plugin = (options = {}) => {
  options = { ...defaultOptions, ...options }
  return {
    name: "vite-plugin-twig-drupal",
    config: ({ root }) => {
      if (!options.root) {
        options.root = root
      }
    },
    async shouldTransformCachedModule(src, id) {
      return options.pattern.test(id)
    },
    async transform(src, id) {
      if (options.pattern.test(id)) {
        let frameworkInclude = ""
        let frameworkTransform = "const frameworkTransform = (html) => html;"

        let asTwigJs = id.match(/\?twig$/)

        if (options.framework === FRAMEWORK_REACT && !asTwigJs) {
          frameworkInclude = `import React from 'react'`
          frameworkTransform = `const frameworkTransform = (html) => React.createElement('div', {dangerouslySetInnerHTML: {'__html': html}});;`
        }

        if (asTwigJs) {
          // Tidy up file path by remove ?twig
          id = id.slice(0, -5)
        }

        let embed,
          embeddedIncludes,
          functions,
          code,
          includes,
          seen = {}

        try {
          const result = await compileTemplate(id, id, options).catch(
            errorHandler(id)
          )
          if ("map" in result) {
            // An error occurred.
            return result
          }
          code = result.code
          includes = result.includes

          // Process includes in a queue.
          const promisifyIncludes = (includes) => {
            return includes.reduce(
              (queue, template) =>
                queue.then(() => {
                  const file = resolveFile(
                    dirname(id),
                    resolveNamespaceOrComponent(options.namespaces, template)
                  )
                  if (!(template in seen)) {
                    return compileTemplate(template, file, options)
                      .catch(errorHandler(template, false))
                      .then(({ code, includes }) => {
                        seen[template] = code
                        if (!includes) {
                          return Promise.resolve()
                        }
                        return promisifyIncludes(includes)
                      })
                  }
                  return Promise.resolve()
                }),
              Promise.resolve()
            )
          }
          const includeResult = await promisifyIncludes(includes).catch(
            errorHandler(id)
          )
          embed = Object.keys(seen)
            .filter((template) => template !== "_self")
            .map(
              (template) => {
                const resolvedPath = resolveFile(
                  dirname(id),
                  resolveNamespaceOrComponent(options.namespaces, template)
                )
                return `import '${resolvedPath}';`
              }
            )
            .join("\n")

          functions = Object.entries(options.functions)
            .map(([name, value]) => {
              return `
              const ${name} = ${value};
              ${name}(Twig);
            `
            })
            .join("\n")

          if (includeResult !== undefined && "map" in includeResult) {
            // An error occurred.
            return includeResult
          }
          embeddedIncludes = Object.values(seen).reverse().join("\n")
        } catch (e) {
          return errorHandler(id)(e)
        }
        const output = `
        import Twig, { twig } from 'twig';
        import DrupalAttribute from 'drupal-attribute';
        import { addDrupalExtensions } from 'drupal-twig-extensions/twig';
        ${frameworkInclude}

        ${embed}

        ${functions}

        addDrupalExtensions(Twig);

        // Disable caching.
        Twig.cache(false);


        ${embeddedIncludes};
        ${frameworkTransform};
        export default (context = {}) => {
          const component = ${code}
          ${includes ? `component.options.allowInlineIncludes = true;` : ""}
          try {
            let defaultAttributes = context.defaultAttributes ? context.defaultAttributes : [];
            if (!Array.isArray(defaultAttributes)) {
              // We were passed a map, turn it into an array.
              defaultAttributes = Object.entries(defaultAttributes);
            }
            return frameworkTransform(component.render({
              attributes: new DrupalAttribute(defaultAttributes),
              ...${JSON.stringify(options.globalContext)},
              ...context
            }));
          }
          catch (e) {
            return frameworkTransform('An error occurred whilst rendering ${id}: ' + e.toString());
          }
        }`
        return {
          code: output,
          map: null,
          dependencies: seen,
        }
      }
    },
  }
}

export default plugin
