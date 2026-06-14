/**
 * InputPipeline 上下文。
 *
 * 设计文档:模块设计/消息预处理工程/设计.md §4.1.1。
 */

import type { PermissionMode } from "../../permission/index.js";
import type { FilePart, ImagePart } from "../../types/index.js";

/** InputPipeline 累积的附件:作为独立 ContentPart 输出,不再 XML wrap 到 text。 */
export type InputAttachment = FilePart | ImagePart;

export interface InputWarning {
  stage: string;
  message: string;
}

export interface InputSlashCommand {
  name: string;
  args: string;
}

export interface InputPreprocessSettings {
  atFileExpand?: {
    enabled?: boolean;
    /** 单文件上限(字节)。 */
    maxBytes?: number;
  };
  atImage?: {
    enabled?: boolean;
    /** 单图上限(字节,base64 前)。默认 5MB。 */
    maxBytes?: number;
  };
  templateExpand?: {
    enabled?: boolean;
  };
  /** 用户消息总字符上限(超出截断 + warning)。默认 32768。 */
  maxChars?: number;
  redactPreScan?: {
    enabled?: boolean;
  };
}

/** Active model 的能力描述,由 caller 在创建 InputCtx 时注入。 */
export interface InputCapabilities {
  /** 当前 model 是否能消费 image part。false 时 at-image stage skip + warning。 */
  supportsImages?: boolean;
}

export interface InputCtx {
  /** 用户原始输入(已展开 paste 占位符)。 */
  raw: string;
  /** stage 之间累计修改的当前值。 */
  text: string;
  /** 来源。 */
  source: "tty" | "stdin" | "argv";
  /** 当前会话的 cwd,用于 @file 解析。 */
  cwd: string;
  /** 命中的 slash 命令(若有);命中后 pipeline 短路。 */
  slashCommand?: InputSlashCommand;
  /** stage 附加的 attachments。 */
  attachments: InputAttachment[];
  /** 不阻断的告警。 */
  warnings: InputWarning[];
  /**
   * 已加载的 skill 名(扩展接入口 §十 v0.3.x @skill mention)。
   * at-skill-expand stage 据此判定 `@<name>` 是 skill 引用还是文件路径。
   * 空 / 未注入 → @skill 检测关闭(行为同旧版)。
   */
  skillNames?: string[];
  /** at-skill-expand stage 检测到的待激活 skill 名(caller 在 pipeline 后激活)。 */
  skillActivations: string[];
  /** 当前 PermissionMode。 */
  mode: PermissionMode;
  /** settings.preprocess.input 配置。 */
  settings: InputPreprocessSettings;
  /** Active model 能力(用于 at-image 等需要 vision 的 stage 判断)。 */
  capabilities?: InputCapabilities;
}

export function createInputCtx(init: {
  raw: string;
  source: InputCtx["source"];
  cwd: string;
  mode: PermissionMode;
  settings?: InputPreprocessSettings;
  capabilities?: InputCapabilities;
  skillNames?: string[];
}): InputCtx {
  return {
    raw: init.raw,
    text: init.raw,
    source: init.source,
    cwd: init.cwd,
    attachments: [],
    warnings: [],
    mode: init.mode,
    settings: init.settings ?? {},
    capabilities: init.capabilities,
    skillNames: init.skillNames,
    skillActivations: [],
  };
}
