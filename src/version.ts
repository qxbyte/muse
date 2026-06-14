/**
 * 单一版本号源。与 package.json "version" 字段手动同步。
 * 多处引用（commander --version、启动 banner 等）避免漏改不一致。
 */
export const VERSION = "0.3.0";
