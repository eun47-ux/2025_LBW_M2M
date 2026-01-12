// backend/services/concatVideos.js
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

export async function concatVideos(videoPaths, outPath) {
  if (!Array.isArray(videoPaths) || videoPaths.length === 0) {
    throw new Error("videoPaths must be a non-empty array");
  }

  const concatListPath = path.join(path.dirname(outPath), "concat.txt");
  const listContent = videoPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(concatListPath, listContent, "utf-8");

  await new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", outPath],
      { stdio: "inherit" }
    );
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.on("error", reject);
  });

  return { outPath, concatListPath };
}
