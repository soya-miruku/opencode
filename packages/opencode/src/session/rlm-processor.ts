/**
 * RLM Pre-processor
 *
 * Implements the Recursive Language Model approach from the paper:
 * "Recursive Language Models" (Zhang et al., 2025)
 *
 * For large codebases, this processor:
 * 1. Detects when a query needs RLM processing
 * 2. Gathers relevant context via grep/glob
 * 3. Delegates to the RLM agent for analysis
 * 4. Returns synthesized context to the primary agent
 */

import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import { spawn } from "child_process"
// Note: Removed Session, Identifier, Agent imports to avoid circular dependency
// These were only used in the process() function which is not currently needed

const log = Log.create({ service: "rlm-processor" })

// Patterns that indicate broad codebase questions
const BROAD_QUERY_PATTERNS = [
  /how\s+(does|do|is|are)\s+\w+\s+work/i,
  /how\s+.*\s+work/i,  // "how they work", "how tools work"
  /tell\s+me\s+(about|how|all)/i,  // "tell me all areas"
  /can\s+you\s+tell\s+me/i,  // "can you tell me"
  /explain\s+(how|the|all)/i,
  /what\s+(is|are)\s+the\s+\w+\s+(pattern|architecture|structure)/i,
  /give\s+me\s+(an?\s+)?overview/i,
  /find\s+all\s+(places|instances|occurrences|areas)/i,
  /where\s+(is|are)\s+\w+\s+(used|defined|implemented|created)/i,
  /show\s+me\s+(all|every|the)/i,
  /list\s+(all|every|the)/i,
  /what\s+patterns/i,
  /how\s+.*\s+across\s+the\s+codebase/i,
  /all\s+areas\s+where/i,  // "all areas where tools are used"
  /how\s+.*\s+(are|is)\s+(used|created|defined|implemented)/i,  // "how tools are used"
]

export namespace RLMProcessor {
  export interface CodebaseMetrics {
    fileCount: number
    totalLines: number
    isLarge: boolean
    isVeryLarge: boolean
  }

  /**
   * Check if RLM processing is enabled
   */
  function isReplToolEnabled(value: unknown): boolean {
    if (value === true) return true
    if (typeof value === "string") return value.toLowerCase() === "true"
    if (typeof value === "number") return value === 1
    return false
  }

  /**
   * Get codebase metrics
   */
  export async function getCodebaseMetrics(): Promise<CodebaseMetrics | null> {
    try {
      const config = await Config.get()
      if (!isReplToolEnabled(config.experimental?.repl_tool)) {
        return null
      }

      const projectDir = Instance.directory
      log.info("Getting codebase metrics", { projectDir })
      let files: string[] = []

      // Try git ls-files first (faster, respects gitignore)
      try {
        const result = await new Promise<string>((resolve, reject) => {
          const proc = spawn("git", ["ls-files"], { cwd: projectDir })
          let output = ""
          proc.stdout.on("data", (data) => (output += data))
          proc.on("close", (code) => (code === 0 ? resolve(output) : reject()))
          proc.on("error", reject)
        })
        files = result.trim().split("\n").filter(Boolean)
      } catch (gitErr) {
        log.info("git ls-files failed, trying find", { error: String(gitErr) })
        // Fallback to find
        try {
          const result = await new Promise<string>((resolve, reject) => {
            const proc = spawn("find", [".", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], { cwd: projectDir })
            let output = ""
            proc.stdout.on("data", (data) => (output += data))
            proc.on("close", (code) => (code === 0 ? resolve(output) : reject()))
            proc.on("error", reject)
          })
          files = result.trim().split("\n").filter(Boolean)
        } catch {
          return null
        }
      }

      const fileCount = files.length
      // Estimate lines (rough)
      const totalLines = fileCount * 100 // Rough estimate

      return {
        fileCount,
        totalLines,
        isLarge: fileCount > 50 || totalLines > 50000,
        isVeryLarge: fileCount > 200 || totalLines > 200000,
      }
    } catch (e) {
      log.error("Failed to get codebase metrics", { error: e })
      return null
    }
  }

  /**
   * Check if query matches broad patterns
   */
  export function isBroadQuery(query: string): boolean {
    return BROAD_QUERY_PATTERNS.some((pattern) => pattern.test(query))
  }

  /**
   * Gather relevant context for a query using grep
   */
  export async function gatherContext(query: string): Promise<string[]> {
    const projectDir = Instance.directory
    const keywords = extractKeywords(query)
    const files: Set<string> = new Set()

    log.info("Gathering context", { query, keywords, projectDir })

    for (const keyword of keywords) {
      try {
        const result = await new Promise<string>((resolve, reject) => {
          const proc = spawn("rg", ["-l", keyword, "--type", "ts", "--type", "js", "-g", "!node_modules"], {
            cwd: projectDir,
            timeout: 10000
          })
          let output = ""
          proc.stdout.on("data", (data) => (output += data))
          proc.on("close", (code) => resolve(output))
          proc.on("error", () => resolve(""))
        })
        result.trim().split("\n").filter(Boolean).forEach((f) => files.add(f))
      } catch {
        // Ignore errors
      }
    }

    return Array.from(files).slice(0, 50) // Limit to 50 files
  }

  /**
   * Extract keywords from query for searching
   */
  function extractKeywords(query: string): string[] {
    // Remove common words and extract meaningful terms
    const stopWords = new Set([
      "how", "does", "do", "is", "are", "the", "a", "an", "in", "on", "at",
      "to", "for", "of", "with", "by", "from", "up", "about", "into", "through",
      "during", "before", "after", "above", "below", "between", "under", "again",
      "further", "then", "once", "here", "there", "when", "where", "why", "all",
      "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not",
      "only", "own", "same", "so", "than", "too", "very", "can", "will", "just",
      "should", "now", "tell", "me", "show", "give", "find", "what", "which",
      "please", "work", "used", "using", "across", "codebase", "code", "base",
      "explain", "overview", "list", "every", "places", "instances"
    ])

    const words = query
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))

    // Return unique keywords, prioritize longer words
    return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 5)
  }

  // Note: process() function removed to avoid circular dependency
  // RLM processing is now done by injecting subtasks directly in prompt.ts

  /**
   * Check if a query should be processed by RLM
   */
  export async function shouldProcess(query: string): Promise<boolean> {
    const config = await Config.get()
    const replEnabled = isReplToolEnabled(config.experimental?.repl_tool)

    log.info("RLM shouldProcess check", {
      query: query.slice(0, 100),
      repl_tool_value: config.experimental?.repl_tool,
      replEnabled,
    })

    if (!replEnabled) {
      log.info("RLM disabled - repl_tool not enabled")
      return false
    }

    const metrics = await getCodebaseMetrics()
    log.info("RLM codebase metrics", { metrics })

    if (!metrics || !metrics.isLarge) {
      log.info("RLM skipped - codebase not large enough", { metrics })
      return false
    }

    const isBroad = isBroadQuery(query)
    log.info("RLM broad query check", {
      isBroad,
      query: query.slice(0, 100),
    })

    if (!isBroad) {
      log.info("RLM skipped - query not broad enough")
      return false
    }

    log.info("RLM will process this query", {
      fileCount: metrics.fileCount,
      isLarge: metrics.isLarge,
      isVeryLarge: metrics.isVeryLarge,
    })

    return true
  }
}
