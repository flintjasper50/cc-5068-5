import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderSong, referenceSong, takeSong, transientSong } from "../src/fixtures/synth";
import { encodeWav } from "../src/engine/wav";

const outDir = join(process.cwd(), "public", "fixtures");
mkdirSync(outDir, { recursive: true });

const songs: { name: string; spec: ReturnType<typeof referenceSong> }[] = [
  { name: "reference", spec: referenceSong() },
  { name: "take", spec: takeSong() },
  { name: "transient", spec: transientSong() }
];

const manifest: { id: string; file: string; label: string; duration: number }[] = [];
for (const { name, spec } of songs) {
  const song = renderSong(spec);
  const wav = encodeWav(song.channels, song.sampleRate);
  const file = `${name}.wav`;
  writeFileSync(join(outDir, file), Buffer.from(wav));
  manifest.push({
    id: name,
    file: `/fixtures/${file}`,
    label:
      name === "reference"
        ? "Reference (synth): intro / verse / chorus / verse reprise (key change) / bridge / chorus reprise (altered ending)"
        : name === "take"
          ? "Take (synth): verse reprise drops one bar"
          : "Transient stress (synth): +10 dB bump inside a section",
    duration: song.duration
  });
  console.log(`wrote ${file} ${song.duration.toFixed(2)}s`);
}

writeFileSync(
  join(outDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
console.log(`wrote manifest.json (${manifest.length} entries)`);
void dirname;
