import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

// Existing client data-loading and controlled-dialog effects predate the
// React 19 rule. Keep the exception as an explicit baseline so new files are
// checked by default and this list can shrink as those components migrate.
const legacySetStateInEffectFiles = [
  "app/(utility)/notebook/page.tsx",
  "app/(utility)/question-notebook/page.tsx",
  "app/(utility)/settings/agents/page.tsx",
  "app/(utility)/settings/capabilities/page.tsx",
  "app/(utility)/settings/document-parsing/page.tsx",
  "app/(utility)/settings/mineru/page.tsx",
  "app/(utility)/settings/network/page.tsx",
  "app/(utility)/settings/status/page.tsx",
  "app/(utility)/settings/tools/page.tsx",
  "app/(utility)/space/chat-history/page.tsx",
  "app/(utility)/space/cli-apps/page.tsx",
  "app/(utility)/space/learning/page.tsx",
  "app/(utility)/space/mcp/page.tsx",
  "app/(utility)/space/personas/page.tsx",
  "app/(utility)/space/skills/page.tsx",
  "app/(workspace)/book/page.tsx",
  "app/(workspace)/co-writer/page.tsx",
  "app/(workspace)/co-writer/\\[docId\\]/page.tsx",
  "app/(workspace)/home/\\[\\[...sessionId\\]\\]/page.tsx",
  "app/(workspace)/partners/page.tsx",
  "app/(workspace)/partners/\\[partnerId\\]/page.tsx",
  "app/(workspace)/playground/page.tsx",
  "components/book/BlockView.tsx",
  "components/book/BookCreator.tsx",
  "components/chat/Markdown.tsx",
  "components/knowledge/create-kb-dialog.tsx",
  "components/knowledge/kb-file-list.tsx",
  "components/knowledge/use-knowledge-bases.ts",
  "components/memory/MemoryDocWorkbench.tsx",
  "components/memory/MemoryGraphView.tsx",
  "components/memory/MemoryHub.tsx",
  "components/memory/MemoryL1Workbench.tsx",
  "components/notebook/EntryEditDialog.tsx",
  "components/notebook/NotebookFormDialog.tsx",
  "components/notebook/NotebookRecords.tsx",
  "components/notebook/RecordFormDialog.tsx",
  "components/partners/partner-chat.tsx",
  "components/partners/partner-config.tsx",
  "components/partners/partner-sessions.tsx",
  "components/partners/soul-editor.tsx",
  "components/playground/JsonConfigEditor.tsx",
  "components/settings/CodexOAuthCard.tsx",
  "components/shell/AppShell.tsx",
  "components/space/EduHubImportDialog.tsx",
  "components/space/McpCatalogBrowser.tsx",
  "components/space/McpServerFormDialog.tsx",
  "components/space/McpToolGroups.tsx",
  "components/space/PersonaFormDialog.tsx",
  "components/space/SkillDetailDialog.tsx",
  "components/space/SkillFormDialog.tsx",
  "context/AppShellContext.tsx",
];

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: legacySetStateInEffectFiles,
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  globalIgnores([
    ".next*/**",
    "out/**",
    "build/**",
    "dist/**",
    "next-env.d.ts",
    "scripts/shots/**",
  ]),
]);
