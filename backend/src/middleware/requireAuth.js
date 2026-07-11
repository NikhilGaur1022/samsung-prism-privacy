// Fail-closed dev stub: attaches a placeholder req.user in dev so downstream
// code has a consistent shape to read, but server.js refuses to boot in
// production unless a real auth provider is wired in (see boot guard).
export function requireAuth(req, _res, next) {
  req.user = { id: null, role: 'dev' }
  next()
}
