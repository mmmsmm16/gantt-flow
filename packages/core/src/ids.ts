// ID 生成。テストでは決定論化のため注入できる（`docs/04-sync-spec.md` の idGen）。
export type IdGen = () => string;

// 既定は UUID v4。Node 22 / モダンブラウザの両方で globalThis.crypto が使える。
export const uuid: IdGen = () => globalThis.crypto.randomUUID();
