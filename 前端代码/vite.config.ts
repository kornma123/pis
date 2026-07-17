import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_BUILD_IDENTITY = "local";
const CONFIG_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function readBuildIdentity(name: "RELEASE_SHA" | "BUILD_ID"): string {
  const value = process.env[name];
  if (value === undefined) return LOCAL_BUILD_IDENTITY;

  if (!value || value !== value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a non-empty printable value of at most 256 characters`);
  }
  return value;
}

function readReproducibilityEnvDir(): string | undefined {
  const value = process.env.COREONE_REPRO_ENV_DIR;
  if (value === undefined) return undefined;
  if (!path.isAbsolute(value)) throw new Error("COREONE_REPRO_ENV_DIR must be an absolute path");
  return value;
}

function buildMetadataPlugin(): Plugin {
  const metadata = {
    schemaVersion: 1,
    releaseSha: readBuildIdentity("RELEASE_SHA"),
    buildId: readBuildIdentity("BUILD_ID"),
  };

  return {
    name: "coreone-build-metadata",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-meta.json",
        source: `${JSON.stringify(metadata, null, 2)}\n`,
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(() => ({
  envDir: readReproducibilityEnvDir(),
  server: {
    host: true,
    port: 8080,
    cors: true,
    hmr: {
      overlay: false,
    },
    // 添加缓存控制头
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  },
  plugins: [react(), buildMetadataPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(CONFIG_DIRECTORY, "./src"),
    },
  },
  optimizeDeps: {
    entries: ['index.html'],
  },
  // 构建配置 - 文件名只由内容决定，构建身份单独写入 build-meta.json
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('xlsx') || id.includes('jspdf')) return 'vendor-export'
            if (id.includes('recharts')) return 'vendor-charts'
            if (id.includes('lucide-react')) return 'vendor-icons'
            if (id.includes('framer-motion')) return 'vendor-animation'
          }
        },
      },
    },
  },
}));
