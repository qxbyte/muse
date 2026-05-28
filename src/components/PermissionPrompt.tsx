/**
 * 工具调用的权限确认 prompt。
 */

import React from "react";
import { Box, Text, useInput } from "ink";

export interface PermissionRequest {
  toolName: string;
  args: unknown;
  summary: string;
  resolve: (approved: boolean) => void;
}

export function PermissionPrompt({ request }: { request: PermissionRequest }) {
  useInput((input, key) => {
    if (input === "y" || key.return) {
      request.resolve(true);
    } else if (input === "n" || key.escape) {
      request.resolve(false);
    }
  });

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>⏵ Approve {request.toolName}?</Text>
      <Text dimColor>{request.summary}</Text>
      <Box marginTop={1}>
        <Text>(y)es / (n)o / Enter=allow / Esc=reject</Text>
      </Box>
    </Box>
  );
}
