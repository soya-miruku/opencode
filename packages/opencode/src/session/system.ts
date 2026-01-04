import { Ripgrep } from "../file/ripgrep"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Log } from "../util/log"

import { Instance } from "../project/instance"
import path from "path"
import os from "os"
import { $ } from "bun"

const log = Log.create({ service: "system-prompt" })

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_ANTHROPIC_SPOOF from "./prompt/anthropic_spoof.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_RLM_AUTO from "./prompt/rlm-auto.txt"
import type { Provider } from "@/provider/provider"

// Helper to handle both boolean true and string "true"
function isReplToolEnabled(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === "string") return value.toLowerCase() === "true"
  if (typeof value === "number") return value === 1
  return false
}

export interface CodebaseMetrics {
  fileCount: number
  totalLines: number
  totalBytes: number
  languages: string[]
  isLarge: boolean // > 50 files or > 50K lines
  isVeryLarge: boolean // > 200 files or > 200K lines
  recommendation: "direct" | "rlm-light" | "rlm-full"
}

async function analyzeCodebase(): Promise<CodebaseMetrics | null> {
  try {
    const config = await Config.get()
    log.info("analyzeCodebase called", {
      repl_tool_enabled: config.experimental?.repl_tool,
      experimental: config.experimental
    })
    const replEnabled = isReplToolEnabled(config.experimental?.repl_tool)
    log.info("RLM config check", {
      repl_tool_value: config.experimental?.repl_tool,
      repl_tool_type: typeof config.experimental?.repl_tool,
      enabled: replEnabled
    })
    if (!replEnabled) {
      log.info("RLM disabled - repl_tool not enabled in config")
      return null
    }

    // Count files using git or find
    const project = Instance.project
    let files: string[] = []

    if (project.vcs === "git") {
      const result = await $`git -C ${Instance.directory} ls-files`.text().catch(() => "")
      files = result.split("\n").filter(Boolean)
    } else {
      // Fallback: use glob for common code files
      const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp,h,hpp,rb,php}")
      files = await Array.fromAsync(
        glob.scan({ cwd: Instance.directory, onlyFiles: true }),
      ).catch(() => [])
    }

    // Sample lines from a subset of files
    let totalLines = 0
    let totalBytes = 0
    const extensions = new Set<string>()

    // Sample up to 100 files for line count estimation
    const sampleSize = Math.min(files.length, 100)
    const sampledFiles = files.slice(0, sampleSize)

    for (const file of sampledFiles) {
      const filepath = path.join(Instance.directory, file)
      try {
        const content = await Bun.file(filepath).text()
        totalLines += content.split("\n").length
        totalBytes += content.length
        const ext = path.extname(file)
        if (ext) extensions.add(ext)
      } catch {
        // Skip unreadable files
      }
    }

    // Extrapolate if we sampled
    if (sampleSize < files.length) {
      const ratio = files.length / sampleSize
      totalLines = Math.round(totalLines * ratio)
      totalBytes = Math.round(totalBytes * ratio)
    }

    const isLarge = files.length > 50 || totalLines > 50000
    const isVeryLarge = files.length > 200 || totalLines > 200000

    let recommendation: "direct" | "rlm-light" | "rlm-full" = "direct"
    if (isVeryLarge) {
      recommendation = "rlm-full"
    } else if (isLarge) {
      recommendation = "rlm-light"
    }

    const metrics = {
      fileCount: files.length,
      totalLines,
      totalBytes,
      languages: Array.from(extensions).slice(0, 10),
      isLarge,
      isVeryLarge,
      recommendation,
    }
    log.info("Codebase metrics computed", metrics)
    return metrics
  } catch (e) {
    log.error("analyzeCodebase failed", { error: e })
    return null
  }
}

export namespace SystemPrompt {
  export function header(providerID: string) {
    if (providerID.includes("anthropic")) return [PROMPT_ANTHROPIC_SPOOF.trim()]
    return []
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function environment() {
    const project = Instance.project
    const metrics = await analyzeCodebase()

    const envLines = [
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${Instance.directory}`,
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
    ]

    if (metrics) {
      envLines.push(`  <codebase-metrics>`)
      envLines.push(`    Files: ${metrics.fileCount}`)
      envLines.push(`    Estimated lines: ${metrics.totalLines.toLocaleString()}`)
      envLines.push(`    Size: ${(metrics.totalBytes / 1024).toFixed(0)}KB`)
      envLines.push(`    Languages: ${metrics.languages.join(", ")}`)
      envLines.push(`    Scale: ${metrics.isVeryLarge ? "very-large" : metrics.isLarge ? "large" : "standard"}`)
      envLines.push(`    RLM recommendation: ${metrics.recommendation}`)
      envLines.push(`  </codebase-metrics>`)
    }

    envLines.push(`</env>`)
    envLines.push(`<files>`)
    envLines.push(
      `  ${
        project.vcs === "git" && false
          ? await Ripgrep.tree({
              cwd: Instance.directory,
              limit: 200,
            })
          : ""
      }`,
    )
    envLines.push(`</files>`)

    return [envLines.join("\n")]
  }

  const LOCAL_RULE_FILES = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md", // deprecated
  ]
  const GLOBAL_RULE_FILES = [
    path.join(Global.Path.config, "AGENTS.md"),
    path.join(os.homedir(), ".claude", "CLAUDE.md"),
  ]

  export async function rlm() {
    const config = await Config.get()
    const replEnabled = isReplToolEnabled(config.experimental?.repl_tool)
    log.info("RLM prompt check", {
      repl_tool_value: config.experimental?.repl_tool,
      repl_tool_type: typeof config.experimental?.repl_tool,
      enabled: replEnabled
    })
    if (replEnabled) {
      log.info("RLM prompt included in system prompt")
      return [PROMPT_RLM_AUTO]
    }
    log.info("RLM prompt NOT included - repl_tool not enabled")
    return []
  }

  export async function custom() {
    const config = await Config.get()
    const paths = new Set<string>()

    for (const localRuleFile of LOCAL_RULE_FILES) {
      const matches = await Filesystem.findUp(localRuleFile, Instance.directory, Instance.worktree)
      if (matches.length > 0) {
        matches.forEach((path) => paths.add(path))
        break
      }
    }

    for (const globalRuleFile of GLOBAL_RULE_FILES) {
      if (await Bun.file(globalRuleFile).exists()) {
        paths.add(globalRuleFile)
        break
      }
    }

    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        let matches: string[] = []
        if (path.isAbsolute(instruction)) {
          matches = await Array.fromAsync(
            new Bun.Glob(path.basename(instruction)).scan({
              cwd: path.dirname(instruction),
              absolute: true,
              onlyFiles: true,
            }),
          ).catch(() => [])
        } else {
          matches = await Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
        }
        matches.forEach((path) => paths.add(path))
      }
    }

    const found = Array.from(paths).map((p) =>
      Bun.file(p)
        .text()
        .catch(() => "")
        .then((x) => "Instructions from: " + p + "\n" + x),
    )
    return Promise.all(found).then((result) => result.filter(Boolean))
  }
}
