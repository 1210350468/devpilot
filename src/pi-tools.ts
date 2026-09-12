import { createRequire } from "node:module";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const INLINE_IMAGE_MAX_ENCODED_BYTES = 4.5 * 1024 * 1024;
const DETAIL_TILE_MAX_ENCODED_BYTES = 768 * 1024;
const DETAIL_TILE_GRID_SIZE = 2;

type PhotonImageLike = {
  free(): void;
  get_width(): number;
  get_height(): number;
  get_bytes_jpeg(quality: number): Uint8Array;
};

type PhotonModule = {
  PhotonImage: {
    new_from_byteslice(bytes: Uint8Array): PhotonImageLike;
  };
  SamplingFilter: { Lanczos3: number };
  crop(image: PhotonImageLike, x1: number, y1: number, x2: number, y2: number): PhotonImageLike;
  resize(image: PhotonImageLike, width: number, height: number, filter: number): PhotonImageLike;
};

export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }
    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
  const params = {
    path,
    offset: input.offset,
    limit: input.limit,
  };

  const originalTool = createReadTool(context.cwd, { autoResizeImages: false });
  const original = await runTool((readInput) => originalTool.execute("read_file", readInput), params, context);
  if (original.isError || !hasOversizedInlineImage(original.content)) return original;

  const resizedTool = createReadTool(context.cwd, { autoResizeImages: true });
  const overview = await runTool((readInput) => resizedTool.execute("read_file", readInput), params, context);
  if (overview.isError) return overview;

  const detailTiles = createDetailTiles(original.content);
  if (detailTiles.length === 0) return overview;

  return {
    ...overview,
    content: [
      ...overview.content,
      {
        type: "text",
        text: "High-resolution detail tiles follow in reading order: top-left, top-right, bottom-left, bottom-right.",
      },
      ...detailTiles,
    ],
  };
}

function hasOversizedInlineImage(content: McpContent[]): boolean {
  return content.some(
    (item) => item.type === "image" && Buffer.byteLength(item.data, "utf8") >= INLINE_IMAGE_MAX_ENCODED_BYTES,
  );
}

function createDetailTiles(content: McpContent[]): McpContent[] {
  const image = content.find((item): item is Extract<McpContent, { type: "image" }> => item.type === "image");
  if (!image) return [];

  const photon = loadPiPhoton();
  if (!photon) return [];

  let source: PhotonImageLike | undefined;
  try {
    source = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data, "base64"));
    const width = source.get_width();
    const height = source.get_height();
    if (width < DETAIL_TILE_GRID_SIZE || height < DETAIL_TILE_GRID_SIZE) return [];

    const output: McpContent[] = [];
    for (let row = 0; row < DETAIL_TILE_GRID_SIZE; row += 1) {
      for (let column = 0; column < DETAIL_TILE_GRID_SIZE; column += 1) {
        const x1 = Math.floor((column * width) / DETAIL_TILE_GRID_SIZE);
        const y1 = Math.floor((row * height) / DETAIL_TILE_GRID_SIZE);
        const x2 = Math.floor(((column + 1) * width) / DETAIL_TILE_GRID_SIZE);
        const y2 = Math.floor(((row + 1) * height) / DETAIL_TILE_GRID_SIZE);
        const tile = photon.crop(source, x1, y1, x2, y2);
        try {
          const encoded = encodeTile(photon, tile);
          if (!encoded) return [];
          output.push(
            {
              type: "text",
              text: `Detail tile ${row * DETAIL_TILE_GRID_SIZE + column + 1}/4: source pixels x=${x1}-${x2 - 1}, y=${y1}-${y2 - 1}.`,
            },
            { type: "image", data: encoded, mimeType: "image/jpeg" },
          );
        } finally {
          tile.free();
        }
      }
    }
    return output;
  } catch {
    return [];
  } finally {
    source?.free();
  }
}

function encodeTile(photon: PhotonModule, tile: PhotonImageLike): string | undefined {
  let working = tile;
  try {
    for (let resizeAttempt = 0; resizeAttempt < 5; resizeAttempt += 1) {
      for (const quality of [85, 75, 65, 55, 45]) {
        const data = Buffer.from(working.get_bytes_jpeg(quality)).toString("base64");
        if (Buffer.byteLength(data, "utf8") < DETAIL_TILE_MAX_ENCODED_BYTES) return data;
      }

      const width = working.get_width();
      const height = working.get_height();
      if (width <= 1 && height <= 1) break;
      const resized = photon.resize(
        working,
        Math.max(1, Math.floor(width * 0.75)),
        Math.max(1, Math.floor(height * 0.75)),
        photon.SamplingFilter.Lanczos3,
      );
      if (working !== tile) working.free();
      working = resized;
    }
    return undefined;
  } finally {
    if (working !== tile) working.free();
  }
}

function loadPiPhoton(): PhotonModule | undefined {
  try {
    const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const piRequire = createRequire(piEntry);
    return piRequire("@silvia-odwyer/photon-node") as PhotonModule;
  } catch {
    return undefined;
  }
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const tool = createBashTool(context.cwd);
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}
