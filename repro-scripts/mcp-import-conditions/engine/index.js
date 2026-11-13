import { defineEngine } from "e2e/engine";

export default function importEntryEngine() {
  return defineEngine({
    name: "import-entry",
    version: "1.0.0",
    spiVersion: 1,
    platform: "repro",
    async observe() {
      return {
        root: {
          ref: { id: "root", revision: "" },
          role: "window",
          name: "Import entry",
        },
        viewport: { width: 1, height: 1 },
      };
    },
  });
}
