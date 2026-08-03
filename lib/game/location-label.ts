export const MAP_LABEL_MAX_CHARACTERS = 9;

/** Produces a compact map-only label while keeping canonical names unchanged. */
export function conciseLocationName(name: string) {
  const normalized = name.trim();
  const segments = normalized.split(/[·｜|/]/).map((segment) => segment.trim()).filter(Boolean);
  const prefix = segments.slice(0, -1).join("·");
  let label = segments.at(-1) ?? normalized;

  if (label === "入口" && prefix.includes("之家")) label = "住宅入口";
  label = label.replace(/^洞窟入口\s*/, "洞窟 ").replace(/^帕洛斯手记\s*/, "手记 ").trim();

  const characters = Array.from(label);
  if (characters.length <= MAP_LABEL_MAX_CHARACTERS) return label;
  return `${characters.slice(0, MAP_LABEL_MAX_CHARACTERS - 1).join("")}…`;
}
