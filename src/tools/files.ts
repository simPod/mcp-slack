import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FilesUploadV2Arguments } from '@slack/web-api';
import { registerTool, rawToolResult } from '@/tools/registry.ts';
import type { ToolDeps } from '@/tools/registry.ts';
import { formatResponse, shapeFile } from '@/format/index.ts';

interface UploadResult {
  files?: Record<string, unknown>[];
  file?: Record<string, unknown>;
}

interface RawFileInfo {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  permalink?: string;
  url_private?: string;
  url_private_download?: string;
  channels?: string[];
  groups?: string[];
  ims?: string[];
  shares?: {
    public?: Record<string, unknown>;
    private?: Record<string, unknown>;
  };
}

interface FileInfoResult {
  file?: RawFileInfo;
}

/** Default cap on bytes inlined as image content, to protect the context. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Mimetypes Claude can render as an image content block. Other image types
 * (e.g. `image/svg+xml`, `image/tiff`) fall back to metadata + a download URL.
 */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Unknown/private-only sharing is not proof of access to an allowlisted channel. */
function assertFileAllowed(file: RawFileInfo, channelIds: readonly string[]): void {
  if (channelIds.length === 0) {
    return;
  }
  const sharedChannels = [
    ...(file.channels ?? []),
    ...(file.groups ?? []),
    ...(file.ims ?? []),
    ...Object.keys(file.shares?.public ?? {}),
    ...Object.keys(file.shares?.private ?? {}),
  ];
  if (!sharedChannels.some((id) => channelIds.includes(id))) {
    throw new Error('File is not shared in a configured SLACK_CHANNEL_IDS channel.');
  }
}

async function allowedUploadPath(filePath: string, root: string | undefined): Promise<string> {
  if (root === undefined) {
    throw new Error('Local file uploads are disabled. Set SLACK_MCP_UPLOAD_ROOT to enable them.');
  }
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(resolve(canonicalRoot, filePath));
  const fromRoot = relative(canonicalRoot, canonicalFile);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('file_path must be inside SLACK_MCP_UPLOAD_ROOT.');
  }
  return canonicalFile;
}

export function registerFileTools(server: McpServer, deps: ToolDeps): void {
  registerTool(server, deps, {
    name: 'upload_file',
    title: 'Upload a file',
    description:
      'Upload a file to Slack via the modern upload flow (filesUploadV2). Provide inline ' +
      '`content` or a local `file_path`.',
    inputSchema: {
      filename: z.string().describe('File name including extension.'),
      content: z
        .string()
        .optional()
        .describe('Inline file content (mutually exclusive with file_path).'),
      file_path: z.string().optional().describe('Local path to a file to upload.'),
      channel_id: z.string().optional().describe('Channel to share the file into.'),
      title: z.string().optional().describe('Title shown in Slack.'),
      initial_comment: z.string().optional().describe('Message posted alongside the file.'),
      thread_ts: z.string().optional().describe('Share into this thread.'),
    },
    handler: async (args, ctx) => {
      if (args.content === undefined && args.file_path === undefined) {
        throw new Error('Provide either `content` or `file_path`.');
      }
      if (args.content !== undefined && args.file_path !== undefined) {
        throw new Error('Provide only one of `content` or `file_path`, not both.');
      }
      if (ctx.slack.channelIds.length > 0 && args.channel_id === undefined) {
        throw new Error('channel_id is required when SLACK_CHANNEL_IDS is configured.');
      }
      const filePath =
        args.file_path === undefined
          ? undefined
          : await allowedUploadPath(args.file_path, ctx.config.uploadRoot);
      const uploadArgs = {
        filename: args.filename,
        ...(args.content !== undefined ? { content: args.content } : {}),
        ...(filePath !== undefined ? { file: filePath } : {}),
        ...(args.channel_id !== undefined ? { channel_id: args.channel_id } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.initial_comment !== undefined ? { initial_comment: args.initial_comment } : {}),
        ...(args.thread_ts !== undefined ? { thread_ts: args.thread_ts } : {}),
      } as FilesUploadV2Arguments;
      const res = await ctx.slack.call<UploadResult>('bot-preferred', (c) =>
        c.filesUploadV2(uploadArgs),
      );
      const files = res.files ?? (res.file !== undefined ? [res.file] : []);
      return { ok: true, files: files.map(shapeFile) };
    },
  });

  registerTool(server, deps, {
    name: 'get_file',
    title: 'Fetch a file',
    description:
      "Fetch a Slack file by ID (as listed in a message's `files`). Supported image types " +
      '(png, jpeg, gif, webp) are downloaded and returned as viewable image content so the ' +
      'model can see them; other types — and images above `max_bytes` — return metadata plus ' +
      'an authenticated `download_url`. Requires the `files:read` scope.',
    inputSchema: {
      file_id: z.string().describe("File ID (e.g. F0123456789), from a message's `files` field."),
      max_bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Max bytes to inline as image data; larger files return metadata only. Default ${DEFAULT_MAX_BYTES}.`,
        ),
    },
    handler: async (args, ctx) => {
      const info = await ctx.slack.call<FileInfoResult>('bot-preferred', (c) =>
        c.files.info({ file: args.file_id }),
      );
      const file = info.file;
      if (file === undefined) {
        throw new Error(`File ${args.file_id} not found.`);
      }
      assertFileAllowed(file, ctx.slack.channelIds);
      const shaped = shapeFile(file);
      const mimetype = file.mimetype ?? '';
      const url = file.url_private_download ?? file.url_private;
      const maxBytes = args.max_bytes ?? DEFAULT_MAX_BYTES;

      const metadata = (note: string): unknown => ({ file: shaped, download_url: url, note });

      if (!INLINE_IMAGE_TYPES.has(mimetype) || url === undefined) {
        return metadata(
          url === undefined
            ? 'No download URL available for this file.'
            : 'Not an inline-viewable image; use download_url to fetch the bytes.',
        );
      }
      if (file.size !== undefined && file.size > maxBytes) {
        return metadata(
          `File size (${file.size}B) exceeds max_bytes (${maxBytes}); metadata only.`,
        );
      }

      const { bytes } = await ctx.slack.fetchFileBytes('bot-preferred', url);
      if (bytes.byteLength > maxBytes) {
        return metadata(
          `File size (${bytes.byteLength}B) exceeds max_bytes (${maxBytes}); metadata only.`,
        );
      }

      const base64 = Buffer.from(bytes).toString('base64');
      return rawToolResult([
        { type: 'text', text: formatResponse({ file: shaped }, ctx.format) },
        { type: 'image', data: base64, mimeType: mimetype },
      ]);
    },
  });
}
