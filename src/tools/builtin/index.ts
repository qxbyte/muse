import type { AnyTool } from "../types.js";
import { ReadTool } from "./read.js";
import { WriteTool } from "./write.js";
import { EditTool } from "./edit.js";
import { BashTool } from "./bash.js";
import { GrepTool } from "./grep.js";
import { GlobTool } from "./glob.js";
import { TodoWriteTool } from "./todo.js";
import { WebFetchTool } from "./webfetch.js";
import { MemoryReadTool, MemoryWriteTool } from "./memory.js";

export {
  ReadTool,
  WriteTool,
  EditTool,
  BashTool,
  GrepTool,
  GlobTool,
  TodoWriteTool,
  WebFetchTool,
  MemoryReadTool,
  MemoryWriteTool,
};

export const BUILTIN_TOOLS: AnyTool[] = [
  ReadTool,
  WriteTool,
  EditTool,
  BashTool,
  GrepTool,
  GlobTool,
  TodoWriteTool,
  WebFetchTool,
  MemoryReadTool,
  MemoryWriteTool,
];
