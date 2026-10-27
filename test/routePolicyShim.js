'use strict'

function withRoutePolicies(router) {
  if (router.routePolicies instanceof Map) return router

  const policies = new Map()
  const methods = ['get', 'post', 'put', 'patch', 'delete']
  const originalMethods = new Map()
  for (const method of methods) {
    if (typeof router[method] !== 'function') continue
    const original = router[method]
    originalMethods.set(method, original)
    router[method] = (route, ...handlers) => {
      policies.set(`${method.toUpperCase()} ${route}`, 'admin')
      return original.call(router, route, ...handlers)
    }
  }

  router.access = (level) => {
    if (level !== 'readonly' && level !== 'readwrite') {
      throw new Error(`Unsupported route access level: ${level}`)
    }
    const scopedRouter = {}
    for (const [method, original] of originalMethods) {
      scopedRouter[method] = (route, ...handlers) => {
        policies.set(`${method.toUpperCase()} ${route}`, level)
        return original.call(router, route, ...handlers)
      }
    }
    return scopedRouter
  }
  router.routePolicies = policies
  return router
}

function wrapPluginRoutes(plugin) {
  const registerWithRouter = plugin.registerWithRouter
  plugin.registerWithRouter = (router) => registerWithRouter(withRoutePolicies(router))
  return plugin
}

module.exports = { withRoutePolicies, wrapPluginRoutes }
