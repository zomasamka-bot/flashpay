export function isOwnerRoute(path: string): boolean {
  return ["/operations", "/control-panel", "/diagnostics", "/emergency"].some(route => path === route || path.startsWith(route + "/"))
}
export function showBottomNavigation(path: string): boolean {
  return !isOwnerRoute(path) && path !== "/pay" && !path.startsWith("/pay/")
}
