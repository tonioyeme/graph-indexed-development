/**
 * State Management for GID MCP
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import { Graph } from './types.js';

export interface ExtractionState {
  lastExtraction: {
    timestamp: string;
    gitCommit?: string;
    gitBranch?: string;
  };
  fileHashes: Record<string, string>;
  config: {
    directories: string[];
    extensions: string[];
    excludeDirs: string[];
  };
}

export interface HistoryEntry {
  timestamp: string;
  filename: string;
  gitCommit?: string;
  nodeCount: number;
  edgeCount: number;
}

export interface ChangedFiles {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
}

export interface GraphDiff {
  addedNodes: string[];
  removedNodes: string[];
  addedEdges: number;
  removedEdges: number;
}

const STATE_FILE = 'state.yml';
const HISTORY_DIR = 'history';
const MAX_HISTORY_ENTRIES = 10;

export function createStateManager(gidDir: string) {
  const stateFile = path.join(gidDir, STATE_FILE);
  const historyDir = path.join(gidDir, HISTORY_DIR);

  return {
    loadState(): ExtractionState | null {
      if (!fs.existsSync(stateFile)) {
        return null;
      }

      try {
        const content = fs.readFileSync(stateFile, 'utf-8');
        return yaml.load(content) as ExtractionState;
      } catch {
        return null;
      }
    },

    saveState(state: ExtractionState): void {
      if (!fs.existsSync(gidDir)) {
        fs.mkdirSync(gidDir, { recursive: true });
      }

      const content = yaml.dump(state, { indent: 2 });
      fs.writeFileSync(stateFile, content, 'utf-8');
    },

    getChangedFiles(currentFiles: string[]): ChangedFiles {
      const state = this.loadState();

      if (!state) {
        return {
          added: currentFiles,
          modified: [],
          deleted: [],
          unchanged: [],
        };
      }

      const previousHashes = state.fileHashes;
      const added: string[] = [];
      const modified: string[] = [];
      const unchanged: string[] = [];

      for (const file of currentFiles) {
        const currentHash = computeFileHash(file);
        const previousHash = previousHashes[file];

        if (!previousHash) {
          added.push(file);
        } else if (currentHash !== previousHash) {
          modified.push(file);
        } else {
          unchanged.push(file);
        }
      }

      const currentFileSet = new Set(currentFiles);
      const deleted = Object.keys(previousHashes).filter(
        (file) => !currentFileSet.has(file)
      );

      return { added, modified, deleted, unchanged };
    },

    saveHistory(graph: Graph): void {
      if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `graph.${timestamp}.yml`;
      const filepath = path.join(historyDir, filename);

      const content = yaml.dump(graph, { indent: 2, lineWidth: 120 });
      fs.writeFileSync(filepath, content, 'utf-8');

      cleanupHistory(historyDir, MAX_HISTORY_ENTRIES);
    },

    listHistory(): HistoryEntry[] {
      if (!fs.existsSync(historyDir)) {
        return [];
      }

      const entries: HistoryEntry[] = [];
      const files = fs.readdirSync(historyDir)
        .filter((f) => f.startsWith('graph.') && f.endsWith('.yml'))
        .sort()
        .reverse();

      for (const filename of files) {
        try {
          const filepath = path.join(historyDir, filename);
          const content = fs.readFileSync(filepath, 'utf-8');
          const graph = yaml.load(content) as Graph;

          const match = filename.match(/graph\.(.+)\.yml/);
          const timestamp = match ? match[1].replace(/-/g, ':').replace('T', ' ') : filename;

          entries.push({
            timestamp,
            filename,
            nodeCount: Object.keys(graph.nodes || {}).length,
            edgeCount: (graph.edges || []).length,
          });
        } catch {
          // Skip invalid files
        }
      }

      return entries;
    },

    loadHistoryVersion(filename: string): Graph | null {
      const filepath = path.join(historyDir, filename);

      if (!fs.existsSync(filepath)) {
        return null;
      }

      try {
        const content = fs.readFileSync(filepath, 'utf-8');
        return yaml.load(content) as Graph;
      } catch {
        return null;
      }
    },
  };
}

export function computeFileHash(filepath: string): string {
  try {
    const content = fs.readFileSync(filepath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

export function computeFileHashes(files: string[]): Record<string, string> {
  const hashes: Record<string, string> = {};

  for (const file of files) {
    const hash = computeFileHash(file);
    if (hash) {
      hashes[file] = hash;
    }
  }

  return hashes;
}

export function getGitCommit(dir: string): string | undefined {
  try {
    const gitDir = findGitDir(dir);
    if (!gitDir) return undefined;

    const headFile = path.join(gitDir, 'HEAD');
    const headContent = fs.readFileSync(headFile, 'utf-8').trim();

    if (headContent.startsWith('ref: ')) {
      const refPath = headContent.slice(5);
      const refFile = path.join(gitDir, refPath);
      if (fs.existsSync(refFile)) {
        return fs.readFileSync(refFile, 'utf-8').trim().slice(0, 8);
      }
    } else {
      return headContent.slice(0, 8);
    }
  } catch {
    return undefined;
  }
}

export function getGitBranch(dir: string): string | undefined {
  try {
    const gitDir = findGitDir(dir);
    if (!gitDir) return undefined;

    const headFile = path.join(gitDir, 'HEAD');
    const headContent = fs.readFileSync(headFile, 'utf-8').trim();

    if (headContent.startsWith('ref: refs/heads/')) {
      return headContent.slice(16);
    }
  } catch {
    return undefined;
  }
}

function findGitDir(startDir: string): string | undefined {
  let dir = startDir;

  while (dir !== path.dirname(dir)) {
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(gitDir)) {
      return gitDir;
    }
    dir = path.dirname(dir);
  }

  return undefined;
}

function cleanupHistory(historyDir: string, maxEntries: number): void {
  const files = fs.readdirSync(historyDir)
    .filter((f) => f.startsWith('graph.') && f.endsWith('.yml'))
    .sort();

  while (files.length > maxEntries) {
    const oldest = files.shift()!;
    fs.unlinkSync(path.join(historyDir, oldest));
  }
}

export function diffGraphs(oldGraph: Graph, newGraph: Graph): GraphDiff {
  const oldNodes = new Set(Object.keys(oldGraph.nodes || {}));
  const newNodes = new Set(Object.keys(newGraph.nodes || {}));

  const addedNodes = [...newNodes].filter((n) => !oldNodes.has(n));
  const removedNodes = [...oldNodes].filter((n) => !newNodes.has(n));

  const oldEdgeCount = (oldGraph.edges || []).length;
  const newEdgeCount = (newGraph.edges || []).length;

  return {
    addedNodes,
    removedNodes,
    addedEdges: Math.max(0, newEdgeCount - oldEdgeCount),
    removedEdges: Math.max(0, oldEdgeCount - newEdgeCount),
  };
}
