export type ServerUpgradeOwner = "game" | "next" | "reject";

export function serverUpgradeOwner(pathname: string, development: boolean): ServerUpgradeOwner {
  if (pathname === "/ws") return "game";
  return development ? "next" : "reject";
}
