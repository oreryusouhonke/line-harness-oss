import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';

/** Create a portable tar.gz fixture without relying on a system tar binary. */
export async function createFixtureTarball(
  outPath: string,
  files: ReadonlyMap<string, Buffer>,
): Promise<void> {
  const pack = tar.pack();
  const writing = pipeline(pack, createGzip(), createWriteStream(outPath));

  for (const [name, contents] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name, size: contents.length, mode: 0o644 }, contents, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  pack.finalize();
  await writing;
}
