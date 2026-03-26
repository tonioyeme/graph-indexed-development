/**
 * GID Visual - Graph Visualization Command
 *
 * Free features: View, zoom, pan, search, click details
 * Pro features: Drag layout, save layout, export, edit mode
 */

import chalk from 'chalk';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { startServer, exportStaticHTML } from '../web/server.js';

export interface VisualOptions {
  port?: number;
  noOpen?: boolean;
  static?: boolean;
  graphPath?: string;
}

export function runVisual(options: VisualOptions = {}): void {
  const graphPath = options.graphPath ?? resolve(process.cwd(), '.gid', 'graph.yml');

  // Check for graph.yml
  if (!existsSync(graphPath)) {
    console.log(chalk.red('Error: No graph found.'));
    console.log(chalk.dim('Run `gid init` or `gid extract` first.'));
    process.exit(1);
  }

  // Static mode: export to HTML file
  if (options.static) {
    const outputPath = resolve(process.cwd(), 'graph.html');
    exportStaticHTML({
      graphPath,
      outputPath,
      open: !options.noOpen,
    });
    return;
  }

  // Server mode (default)
  const port = options.port || 3000;
  startServer({
    port,
    graphPath,
    openBrowser: !options.noOpen,
  });
}
