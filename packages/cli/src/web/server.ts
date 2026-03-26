/**
 * GID Visual - Web Server
 *
 * Serves the graph visualization UI with D3.js
 */

import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import yaml from 'js-yaml';

export interface GraphData {
  nodes: Record<string, unknown>;
  edges: Array<{ from: string; to: string; relation: string }>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerOptions {
  port: number;
  graphPath: string;
  openBrowser: boolean;
}

export function startServer(options: ServerOptions): void {
  const app = express();
  const { port, graphPath, openBrowser } = options;

  app.use(express.json());

  // Serve the visualization HTML
  app.get('/', (req, res) => {
    res.send(generateHTML());
  });

  // API: Get graph data
  app.get('/api/graph', (req, res) => {
    try {
      const content = readFileSync(graphPath, 'utf-8');
      const graph = yaml.load(content) as Record<string, unknown>;
      res.json(graph);
    } catch (error) {
      res.status(500).json({ error: 'Failed to load graph' });
    }
  });

  // API: Get layout
  app.get('/api/layout', (req, res) => {
    const layoutPath = resolve(dirname(graphPath), 'layout.json');
    if (existsSync(layoutPath)) {
      try {
        const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
        res.json(layout);
      } catch {
        res.json({ version: 1, positions: {}, viewport: {} });
      }
    } else {
      res.json({ version: 1, positions: {}, viewport: {} });
    }
  });

  // API: Save layout
  app.post('/api/layout', (req, res) => {
    const layoutPath = resolve(dirname(graphPath), 'layout.json');
    try {
      const layout = {
        version: 1,
        positions: req.body.positions || {},
        viewport: req.body.viewport || {},
        savedAt: new Date().toISOString(),
      };
      writeFileSync(layoutPath, JSON.stringify(layout, null, 2), 'utf-8');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to save layout' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Graph Editing API (Pro CLI)
  // ═══════════════════════════════════════════════════════════════════════════════

  // In-memory edit state (unsaved changes)
  let pendingEdits: {
    nodes: Record<string, unknown>;
    edges: Array<{ from: string; to: string; relation: string }>;
    hasChanges: boolean;
  } | null = null;

  // Load graph into edit state
  function getEditState() {
    if (!pendingEdits) {
      const content = readFileSync(graphPath, 'utf-8');
      const graph = yaml.load(content) as GraphData;
      pendingEdits = {
        nodes: graph.nodes || {},
        edges: graph.edges || [],
        hasChanges: false,
      };
    }
    return pendingEdits;
  }

  // API: Add node
  app.post('/api/graph/node', (req, res) => {
    try {
      const { id, node } = req.body;
      if (!id || !node) {
        return res.status(400).json({ error: 'Missing id or node data' });
      }
      const state = getEditState();
      if (state.nodes[id]) {
        return res.status(400).json({ error: 'Node already exists' });
      }
      state.nodes[id] = node;
      state.hasChanges = true;
      res.json({ success: true, node: { id, ...node } });
    } catch (error) {
      res.status(500).json({ error: 'Failed to add node' });
    }
  });

  // API: Update node
  app.put('/api/graph/node/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { node } = req.body;
      const state = getEditState();
      if (!state.nodes[id]) {
        return res.status(404).json({ error: 'Node not found' });
      }
      state.nodes[id] = { ...state.nodes[id] as object, ...node };
      state.hasChanges = true;
      res.json({ success: true, node: { id, ...state.nodes[id] as object } });
    } catch (error) {
      res.status(500).json({ error: 'Failed to update node' });
    }
  });

  // API: Delete node
  app.delete('/api/graph/node/:id', (req, res) => {
    try {
      const { id } = req.params;
      const state = getEditState();
      if (!state.nodes[id]) {
        return res.status(404).json({ error: 'Node not found' });
      }
      delete state.nodes[id];
      // Remove edges connected to this node
      state.edges = state.edges.filter(e => e.from !== id && e.to !== id);
      state.hasChanges = true;
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete node' });
    }
  });

  // API: Add edge
  app.post('/api/graph/edge', (req, res) => {
    try {
      const { from, to, relation } = req.body;
      if (!from || !to) {
        return res.status(400).json({ error: 'Missing from or to' });
      }
      const state = getEditState();
      // Check if edge already exists
      const exists = state.edges.some(e => e.from === from && e.to === to);
      if (exists) {
        return res.status(400).json({ error: 'Edge already exists' });
      }
      const edge = { from, to, relation: relation || 'depends_on' };
      state.edges.push(edge);
      state.hasChanges = true;
      res.json({ success: true, edge });
    } catch (error) {
      res.status(500).json({ error: 'Failed to add edge' });
    }
  });

  // API: Delete edge
  app.delete('/api/graph/edge', (req, res) => {
    try {
      const { from, to } = req.body;
      if (!from || !to) {
        return res.status(400).json({ error: 'Missing from or to' });
      }
      const state = getEditState();
      const initialLength = state.edges.length;
      state.edges = state.edges.filter(e => !(e.from === from && e.to === to));
      if (state.edges.length === initialLength) {
        return res.status(404).json({ error: 'Edge not found' });
      }
      state.hasChanges = true;
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete edge' });
    }
  });

  // API: Get edit state (for checking unsaved changes)
  app.get('/api/graph/state', (req, res) => {
    const state = getEditState();
    res.json({
      hasChanges: state.hasChanges,
      nodeCount: Object.keys(state.nodes).length,
      edgeCount: state.edges.length,
    });
  });

  // API: Save graph to file
  app.post('/api/graph/save', (req, res) => {
    try {
      const state = getEditState();
      const graph = {
        nodes: state.nodes,
        edges: state.edges,
      };
      const yamlContent = yaml.dump(graph, { lineWidth: -1, noRefs: true });
      writeFileSync(graphPath, yamlContent, 'utf-8');
      state.hasChanges = false;
      res.json({ success: true, message: 'Graph saved' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to save graph' });
    }
  });

  // API: Discard changes
  app.post('/api/graph/discard', (req, res) => {
    pendingEdits = null; // Reset to reload from file
    res.json({ success: true, message: 'Changes discarded' });
  });

  // Start server
  const server = app.listen(port, () => {
    console.log();
    console.log(chalk.green('GID Visual started'));
    console.log(chalk.dim(`Graph: ${graphPath}`));
    console.log();
    console.log(`  ${chalk.cyan('Local:')}   http://localhost:${port}`);
    console.log();
    console.log(chalk.dim('Press Ctrl+C to stop'));
    console.log();

    if (openBrowser) {
      console.log(chalk.cyan('Opening browser...'));
      console.log();
      import('open').then((open) => {
        open.default(`http://localhost:${port}`);
      }).catch(() => {
        // open package not available, skip
      });
    }
  });

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log(chalk.dim('\nShutting down...'));
    server.close();
    process.exit(0);
  });
}

/**
 * Export graph visualization as a static HTML file
 */
export function exportStaticHTML(options: {
  graphPath: string;
  outputPath: string;
  open?: boolean;
}): void {
  const { graphPath, outputPath, open: shouldOpen } = options;

  // Load graph data
  const content = readFileSync(graphPath, 'utf-8');
  const graphData = yaml.load(content) as GraphData;

  // Generate static HTML with embedded data
  const html = generateStaticHTML(graphData);

  // Write to file
  writeFileSync(outputPath, html, 'utf-8');

  console.log();
  console.log(chalk.green('Static visualization generated'));
  console.log(chalk.dim(`Output: ${outputPath}`));
  console.log();

  if (shouldOpen) {
    console.log(chalk.cyan('Opening browser...'));
    console.log();
    import('open').then((open) => {
      open.default(outputPath);
    }).catch(() => {
      // open package not available, show manual path
      console.log(`Open in browser: ${chalk.cyan(`file://${resolve(outputPath)}`)}`);
    });
  } else {
    console.log(`Open in browser: ${chalk.cyan(`file://${resolve(outputPath)}`)}`);
    console.log();
  }
}

/**
 * Generate static HTML with embedded graph data (no server needed)
 */
function generateStaticHTML(graphData: GraphData): string {
  const nodeCount = Object.keys(graphData.nodes || {}).length;
  const edgeCount = (graphData.edges || []).length;
  const graphDataJson = JSON.stringify(graphData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GID Visual - Graph Visualization</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      overflow: hidden;
    }
    #header {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 50px;
      background: #16213e;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      z-index: 100;
      border-bottom: 1px solid #0f3460;
    }
    #header h1 { font-size: 18px; font-weight: 500; color: #e94560; }
    #controls { display: flex; gap: 10px; align-items: center; }
    #controls input {
      padding: 6px 12px;
      border-radius: 4px;
      border: 1px solid #0f3460;
      background: #1a1a2e;
      color: #eee;
      width: 200px;
    }
    #controls button {
      padding: 6px 12px;
      border-radius: 4px;
      border: none;
      background: #e94560;
      color: white;
      cursor: pointer;
    }
    #controls button:hover { background: #ff6b6b; }
    #graph { position: fixed; top: 50px; left: 0; right: 0; bottom: 50px; }
    #footer {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      height: 50px;
      background: #16213e;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      border-top: 1px solid #0f3460;
      font-size: 14px;
      color: #888;
    }
    #footer .stat { margin-right: 20px; }
    #footer .health-score { font-weight: bold; }
    #details {
      position: fixed;
      right: 20px; top: 70px;
      width: 300px;
      background: #16213e;
      border-radius: 8px;
      padding: 20px;
      display: none;
      border: 1px solid #0f3460;
    }
    #details.visible { display: block; }
    #details h3 { color: #e94560; margin-bottom: 10px; }
    #details .property { margin: 8px 0; }
    #details .property label { color: #888; font-size: 12px; display: block; }
    .node { cursor: pointer; }
    .node circle { stroke: #fff; stroke-width: 2px; }
    .node text { fill: #eee; font-size: 12px; pointer-events: none; }
    .link { stroke: #0f3460; stroke-opacity: 0.6; }
    .link.implements { stroke: #4caf50; }
    .link.depends_on { stroke: #2196f3; }
    .link.calls { stroke: #ff9800; }
    .link.reads { stroke: #9c27b0; }
    .link.writes { stroke: #f44336; }
    .legend {
      position: fixed;
      left: 20px; bottom: 70px;
      background: #16213e;
      padding: 15px;
      border-radius: 8px;
      font-size: 12px;
      border: 1px solid #0f3460;
    }
    .legend-item { display: flex; align-items: center; margin: 4px 0; font-size: 11px; }
    .legend-color { width: 20px; height: 3px; margin-right: 8px; }
    .legend-node { width: 14px; height: 14px; border-radius: 50%; margin-right: 8px; }
    .legend-section { margin-bottom: 10px; }
    .legend-title { font-size: 10px; color: #888; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px; }
    .static-badge {
      background: #0f3460;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      margin-left: 10px;
    }
  </style>
</head>
<body>
  <div id="header">
    <h1>GID Visual <span class="static-badge">Static</span></h1>
    <div id="controls">
      <input type="text" id="search" placeholder="Search nodes...">
      <button onclick="resetZoom()">Reset View</button>
    </div>
  </div>

  <div id="graph"></div>

  <div id="details">
    <h3 id="node-name">Node</h3>
    <div id="node-properties"></div>
  </div>

  <div class="legend">
    <div class="legend-section">
      <div class="legend-title">Edge Types</div>
      <div class="legend-item"><div class="legend-color" style="background:#4caf50"></div>implements</div>
      <div class="legend-item"><div class="legend-color" style="background:#2196f3"></div>depends_on</div>
      <div class="legend-item"><div class="legend-color" style="background:#ff9800"></div>calls</div>
      <div class="legend-item"><div class="legend-color" style="background:#9c27b0"></div>reads</div>
      <div class="legend-item"><div class="legend-color" style="background:#f44336"></div>writes</div>
      <div class="legend-item"><svg width="20" height="3" style="margin-right:8px"><line x1="0" y1="1.5" x2="20" y2="1.5" stroke="#2196f3" stroke-width="2" stroke-dasharray="4,2"/></svg>internal (within component)</div>
    </div>
    <div class="legend-section">
      <div class="legend-title">Node Types</div>
      <div class="legend-item"><div class="legend-node" style="background:#e94560"></div>Feature</div>
      <div class="legend-item"><div class="legend-node" style="background:#4caf50"></div>Component</div>
      <div class="legend-item"><div class="legend-node" style="background:#607d8b"></div>File</div>
    </div>
    <div class="legend-section">
      <div class="legend-title">Layers (border color)</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #2196f3"></div>interface</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #4caf50"></div>application</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #ff9800"></div>domain</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #9c27b0"></div>infrastructure</div>
    </div>
  </div>

  <div id="footer">
    <div>
      <span class="stat">Nodes: <span id="node-count">${nodeCount}</span></span>
      <span class="stat">Edges: <span id="edge-count">${edgeCount}</span></span>
      <span class="stat health-score">Health: <span id="health-score">--</span>/100</span>
    </div>
    <div>GID CLI - Static Export</div>
  </div>

  <script>
    // Embedded graph data (no server needed)
    const graphData = ${graphDataJson};

    let simulation = null;
    let svg = null;
    let g = null;
    let zoom = null;

    // Track expanded components
    const expandedNodes = new Set();

    // Type-based colors
    const typeColors = {
      Feature: '#e94560',
      Component: '#4caf50',
      Interface: '#ff9800',
      Data: '#9c27b0',
      File: '#607d8b',
      Test: '#00bcd4',
      Decision: '#795548',
    };

    // Layer-based colors (used for File nodes or as border)
    const layerColors = {
      interface: '#2196f3',    // Blue - API/UI layer
      application: '#4caf50',  // Green - Business logic
      domain: '#ff9800',       // Orange - Core domain
      infrastructure: '#9c27b0', // Purple - Database/external
    };

    // Status-based opacity
    const statusOpacity = {
      active: 1.0,
      in_progress: 0.85,
      draft: 0.5,        // Greyer for proposed/draft nodes
      deprecated: 0.4,   // Faded for deprecated
    };

    function getNodeColor(node) {
      // If node has a layer, use layer color (works for File, Component, etc.)
      if (node.layer && layerColors[node.layer]) {
        return layerColors[node.layer];
      }
      return typeColors[node.type] || '#607d8b';
    }

    function getNodeOpacity(node) {
      return statusOpacity[node.status] || 1.0;
    }

    function calculateHealthScore() {
      const nodes = graphData.nodes || {};
      const edges = graphData.edges || [];
      const nodeIds = Object.keys(nodes);
      const nodeCount = nodeIds.length;

      if (nodeCount === 0) return 0;

      // Calculate orphan nodes (no incoming or outgoing edges)
      const connectedNodes = new Set();
      edges.forEach(e => {
        connectedNodes.add(e.from);
        connectedNodes.add(e.to);
      });
      const orphanCount = nodeIds.filter(id => !connectedNodes.has(id)).length;

      // Calculate nodes missing layers
      const missingLayerCount = nodeIds.filter(id => {
        const node = nodes[id];
        return node.type === 'File' && !node.layer;
      }).length;

      // Calculate nodes missing descriptions
      const missingDescCount = nodeIds.filter(id => !nodes[id].description).length;

      // Calculate score (100 base, deduct for issues)
      const orphanPenalty = Math.min(30, (orphanCount / nodeCount) * 60);
      const layerPenalty = Math.min(20, (missingLayerCount / nodeCount) * 40);
      const descPenalty = Math.min(15, (missingDescCount / nodeCount) * 30);

      const score = Math.max(0, Math.round(100 - orphanPenalty - layerPenalty - descPenalty));
      return score;
    }

    function getVisibleNodes() {
      const nodes = [];
      const nodeMap = {};

      for (const [id, data] of Object.entries(graphData.nodes || {})) {
        if (expandedNodes.has(id) && data.children && data.children.length > 0) {
          // Add parent as collapsed indicator
          const parentNode = { id, ...data, isExpanded: true };
          nodes.push(parentNode);
          nodeMap[id] = parentNode;

          // Add children
          for (const child of data.children) {
            const childNode = { ...child, parentId: id, isChild: true };
            nodes.push(childNode);
            nodeMap[child.id] = childNode;
          }
        } else {
          const node = { id, ...data, hasChildren: data.children && data.children.length > 0 };
          nodes.push(node);
          nodeMap[id] = node;
        }
      }
      return { nodes, nodeMap };
    }

    function getVisibleLinks(nodeMap) {
      const links = [];
      const addedLinks = new Set();

      // Build file-to-component map for resolving external edges
      const fileToComponent = {};
      for (const [id, data] of Object.entries(graphData.nodes || {})) {
        if (data.children) {
          for (const child of data.children) {
            fileToComponent[child.id] = id;
          }
        }
      }

      // Helper to resolve a file ID to its visible node
      function resolveToVisible(fileId) {
        if (nodeMap[fileId]) return fileId;
        const compId = fileToComponent[fileId];
        if (compId && nodeMap[compId]) return compId;
        return null;
      }

      for (const edge of (graphData.edges || [])) {
        const sourceInMap = nodeMap[edge.from];
        const targetInMap = nodeMap[edge.to];

        if (sourceInMap && targetInMap) {
          const linkKey = edge.from + '->' + edge.to;
          if (!addedLinks.has(linkKey)) {
            links.push({ source: edge.from, target: edge.to, relation: edge.relation });
            addedLinks.add(linkKey);
          }
        }
      }

      // Add edges between expanded children (from stored childEdges)
      for (const [id, data] of Object.entries(graphData.nodes || {})) {
        if (expandedNodes.has(id) && data.childEdges) {
          for (const edge of data.childEdges) {
            const linkKey = edge.from + '->' + edge.to;
            if (!addedLinks.has(linkKey)) {
              links.push({ source: edge.from, target: edge.to, relation: edge.relation, isInternal: true });
              addedLinks.add(linkKey);
            }
          }
        }

        // Add external edges from expanded children to other components
        if (expandedNodes.has(id) && data.childExternalEdges) {
          for (const edge of data.childExternalEdges) {
            const sourceVisible = resolveToVisible(edge.from);
            const targetVisible = resolveToVisible(edge.to);

            if (sourceVisible && targetVisible && sourceVisible !== targetVisible) {
              const linkKey = sourceVisible + '->' + targetVisible;
              if (!addedLinks.has(linkKey)) {
                links.push({ source: sourceVisible, target: targetVisible, relation: edge.relation, isExternal: true });
                addedLinks.add(linkKey);
              }
            }
          }
        }
      }

      return links;
    }

    function toggleExpand(nodeId) {
      if (expandedNodes.has(nodeId)) {
        expandedNodes.delete(nodeId);
      } else {
        expandedNodes.add(nodeId);
      }
      renderGraph();
    }

    function renderGraph() {
      const container = document.getElementById('graph');
      const width = container.clientWidth;
      const height = container.clientHeight;

      container.innerHTML = '';

      svg = d3.select('#graph')
        .append('svg')
        .attr('width', width)
        .attr('height', height);

      zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => g.attr('transform', event.transform));

      svg.call(zoom);
      g = svg.append('g');

      const { nodes, nodeMap } = getVisibleNodes();
      const links = getVisibleLinks(nodeMap);

      simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(d => d.isInternal ? 60 : 100))
        .force('charge', d3.forceManyBody().strength(d => d.isChild ? -150 : -300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => d.isChild ? 30 : 50));

      const link = g.append('g')
        .selectAll('line')
        .data(links)
        .join('line')
        .attr('class', d => 'link ' + d.relation + (d.isInternal ? ' internal' : ''))
        .attr('stroke-width', d => d.isInternal ? 1 : 2)
        .attr('stroke-dasharray', d => d.isInternal ? '3,3' : null);

      const node = g.append('g')
        .selectAll('g')
        .data(nodes)
        .join('g')
        .attr('class', d => 'node' + (d.isChild ? ' child-node' : '') + (d.hasChildren ? ' expandable' : ''))
        .on('click', (event, d) => showDetails(d))
        .on('dblclick', (event, d) => {
          if (d.hasChildren || d.isExpanded) {
            event.stopPropagation();
            toggleExpand(d.id);
          }
        });

      node.append('circle')
        .attr('r', d => d.isChild ? 15 : 20)
        .attr('fill', d => getNodeColor(d))
        .attr('opacity', d => getNodeOpacity(d))
        .attr('stroke', d => d.layer ? layerColors[d.layer] : (d.hasChildren ? '#fff' : null))
        .attr('stroke-width', d => d.hasChildren ? 3 : (d.layer ? 3 : 2))
        .attr('stroke-dasharray', d => d.hasChildren && !d.isExpanded ? '4,2' : null);

      // Add expand indicator for expandable nodes
      node.filter(d => d.hasChildren && !d.isExpanded)
        .append('text')
        .text('+')
        .attr('text-anchor', 'middle')
        .attr('dy', 5)
        .attr('fill', '#fff')
        .attr('font-size', '16px')
        .attr('font-weight', 'bold')
        .style('pointer-events', 'none');

      // Add collapse indicator for expanded nodes
      node.filter(d => d.isExpanded)
        .append('text')
        .text('−')
        .attr('text-anchor', 'middle')
        .attr('dy', 5)
        .attr('fill', '#fff')
        .attr('font-size', '20px')
        .attr('font-weight', 'bold')
        .style('pointer-events', 'none');

      node.append('text')
        .text(d => d.id.length > 15 ? d.id.substring(0, 12) + '...' : d.id)
        .attr('text-anchor', 'middle')
        .attr('dy', 35)
        .attr('opacity', d => getNodeOpacity(d));

      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
      });
    }

    function showDetails(node) {
      const details = document.getElementById('details');
      document.getElementById('node-name').textContent = node.id;
      const props = document.getElementById('node-properties');
      props.innerHTML = '';
      ['type', 'description', 'layer', 'path', 'status', 'priority'].forEach(key => {
        if (node[key]) {
          props.innerHTML += \`<div class="property"><label>\${key}</label><div>\${node[key]}</div></div>\`;
        }
      });
      details.classList.add('visible');
    }

    function resetZoom() {
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    }

    document.getElementById('search').addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      d3.selectAll('.node').each(function(d) {
        const match = d.id.toLowerCase().includes(query);
        d3.select(this).style('opacity', query === '' ? 1 : (match ? 1 : 0.2));
      });
    });

    // Update health score and render on load
    document.getElementById('health-score').textContent = calculateHealthScore();
    renderGraph();
  </script>
</body>
</html>`;
}

function generateHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GID Visual - Graph Visualization</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      overflow: hidden;
    }
    #header {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 50px;
      background: #16213e;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      z-index: 100;
      border-bottom: 1px solid #0f3460;
    }
    #header h1 { font-size: 18px; font-weight: 500; color: #e94560; }
    #controls { display: flex; gap: 10px; align-items: center; }
    #controls input {
      padding: 6px 12px;
      border-radius: 4px;
      border: 1px solid #0f3460;
      background: #1a1a2e;
      color: #eee;
      width: 200px;
    }
    #controls button {
      padding: 6px 12px;
      border-radius: 4px;
      border: none;
      background: #e94560;
      color: white;
      cursor: pointer;
    }
    #controls button:hover { background: #ff6b6b; }
    #graph { position: fixed; top: 50px; left: 0; right: 0; bottom: 50px; }
    #footer {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      height: 50px;
      background: #16213e;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      border-top: 1px solid #0f3460;
      font-size: 14px;
      color: #888;
    }
    #footer .stat { margin-right: 20px; }
    #footer .health-score { font-weight: bold; }
    #details {
      position: fixed;
      right: 20px; top: 70px;
      width: 300px;
      background: #16213e;
      border-radius: 8px;
      padding: 20px;
      display: none;
      border: 1px solid #0f3460;
    }
    #details.visible { display: block; }
    #details h3 { color: #e94560; margin-bottom: 10px; }
    #details .property { margin: 8px 0; }
    #details .property label { color: #888; font-size: 12px; display: block; }
    .node { cursor: pointer; }
    .node circle { stroke: #fff; stroke-width: 2px; }
    .node text { fill: #eee; font-size: 12px; pointer-events: none; }
    .link { stroke: #0f3460; stroke-opacity: 0.6; }
    .link.implements { stroke: #4caf50; }
    .link.depends_on { stroke: #2196f3; }
    .link.calls { stroke: #ff9800; }
    .link.reads { stroke: #9c27b0; }
    .link.writes { stroke: #f44336; }
    .legend {
      position: fixed;
      left: 20px; bottom: 70px;
      background: #16213e;
      padding: 15px;
      border-radius: 8px;
      font-size: 12px;
      border: 1px solid #0f3460;
    }
    .legend-item { display: flex; align-items: center; margin: 4px 0; font-size: 11px; }
    .legend-color { width: 20px; height: 3px; margin-right: 8px; }
    .legend-node { width: 14px; height: 14px; border-radius: 50%; margin-right: 8px; }
    .legend-section { margin-bottom: 10px; }
    .legend-title { font-size: 10px; color: #888; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px; }
    /* Edit UI Styles */
    .divider { color: #0f3460; margin: 0 5px; }
    .save-btn { background: #4caf50 !important; }
    .save-btn:disabled { background: #333 !important; opacity: 0.5; cursor: not-allowed; }
    .edit-status { font-size: 12px; color: #888; margin-left: 10px; }
    .edit-status.unsaved { color: #ff9800; }
    .dialog {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 8px;
      padding: 20px;
      z-index: 200;
      display: none;
      min-width: 350px;
    }
    .dialog.visible { display: block; }
    .dialog h3 { color: #e94560; margin-bottom: 15px; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 12px; color: #888; margin-bottom: 4px; }
    .form-group input, .form-group select {
      width: 100%;
      padding: 8px;
      border-radius: 4px;
      border: 1px solid #0f3460;
      background: #1a1a2e;
      color: #eee;
    }
    .dialog-buttons { display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px; }
    .dialog-buttons button { padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; }
    .dialog-buttons button.primary { background: #e94560; color: white; }
    .dialog-buttons button.danger { background: #f44336; color: white; margin-right: auto; }
    .dialog-buttons button:not(.primary):not(.danger) { background: #333; color: #eee; }
    .overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 150;
      display: none;
    }
    .overlay.visible { display: block; }
    .context-menu {
      position: fixed;
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 5px 0;
      z-index: 300;
      display: none;
      min-width: 150px;
    }
    .context-menu.visible { display: block; }
    .context-menu div {
      padding: 8px 15px;
      cursor: pointer;
    }
    .context-menu div:hover { background: #0f3460; }
    .context-menu div.danger { color: #f44336; }
    .node.selected circle { stroke: #e94560 !important; stroke-width: 4px !important; }
    .node.edge-source circle { stroke: #4caf50 !important; stroke-width: 4px !important; }
    .edge-mode-hint {
      position: fixed;
      top: 60px; left: 50%;
      transform: translateX(-50%);
      background: #4caf50;
      color: white;
      padding: 10px 20px;
      border-radius: 4px;
      display: none;
      z-index: 100;
    }
    .edge-mode-hint.visible { display: block; }
  </style>
</head>
<body>
  <div id="header">
    <h1>GID Visual</h1>
    <div id="controls">
      <input type="text" id="search" placeholder="Search nodes...">
      <button onclick="resetZoom()">Reset View</button>
      <span class="divider">|</span>
      <button id="add-node-btn" onclick="showAddNodeDialog()">+ Node</button>
      <button id="save-btn" onclick="saveGraph()" class="save-btn" disabled>Save</button>
      <span id="edit-status" class="edit-status"></span>
    </div>
  </div>

  <!-- Add Node Dialog -->
  <div id="add-node-dialog" class="dialog">
    <h3>Add Node</h3>
    <div class="form-group">
      <label>ID (required)</label>
      <input type="text" id="new-node-id" placeholder="e.g., src/utils/helper.ts">
    </div>
    <div class="form-group">
      <label>Type</label>
      <select id="new-node-type">
        <option value="File">File</option>
        <option value="Component">Component</option>
        <option value="Feature">Feature</option>
        <option value="Interface">Interface</option>
        <option value="Data">Data</option>
      </select>
    </div>
    <div class="form-group">
      <label>Layer</label>
      <select id="new-node-layer">
        <option value="">None</option>
        <option value="interface">Interface</option>
        <option value="application">Application</option>
        <option value="domain">Domain</option>
        <option value="infrastructure">Infrastructure</option>
      </select>
    </div>
    <div class="form-group">
      <label>Description</label>
      <input type="text" id="new-node-desc" placeholder="Optional description">
    </div>
    <div class="dialog-buttons">
      <button onclick="hideAddNodeDialog()">Cancel</button>
      <button onclick="addNode()" class="primary">Add</button>
    </div>
  </div>

  <!-- Edit Node Dialog -->
  <div id="edit-node-dialog" class="dialog">
    <h3>Edit Node: <span id="edit-node-id"></span></h3>
    <div class="form-group">
      <label>Type</label>
      <select id="edit-node-type">
        <option value="File">File</option>
        <option value="Component">Component</option>
        <option value="Feature">Feature</option>
        <option value="Interface">Interface</option>
        <option value="Data">Data</option>
      </select>
    </div>
    <div class="form-group">
      <label>Layer</label>
      <select id="edit-node-layer">
        <option value="">None</option>
        <option value="interface">Interface</option>
        <option value="application">Application</option>
        <option value="domain">Domain</option>
        <option value="infrastructure">Infrastructure</option>
      </select>
    </div>
    <div class="form-group">
      <label>Description</label>
      <input type="text" id="edit-node-desc">
    </div>
    <div class="form-group">
      <label>Status</label>
      <select id="edit-node-status">
        <option value="active">Active</option>
        <option value="planned">Planned</option>
        <option value="deprecated">Deprecated</option>
      </select>
    </div>
    <div class="dialog-buttons">
      <button onclick="deleteSelectedNode()" class="danger">Delete</button>
      <button onclick="hideEditNodeDialog()">Cancel</button>
      <button onclick="updateNode()" class="primary">Save</button>
    </div>
  </div>

  <!-- Context Menu -->
  <div id="context-menu" class="context-menu">
    <div onclick="startAddEdge()">Add Edge From Here</div>
    <div onclick="showEditNodeDialogForContext()">Edit Node</div>
    <div onclick="deleteNodeFromContext()" class="danger">Delete Node</div>
  </div>

  <div id="overlay" class="overlay" onclick="closeDialogs()"></div>

  <div id="graph"></div>

  <div id="details">
    <h3 id="node-name">Node</h3>
    <div id="node-properties"></div>
  </div>

  <div class="legend">
    <div class="legend-section">
      <div class="legend-title">Edge Types</div>
      <div class="legend-item"><div class="legend-color" style="background:#4caf50"></div>implements</div>
      <div class="legend-item"><div class="legend-color" style="background:#2196f3"></div>depends_on</div>
      <div class="legend-item"><div class="legend-color" style="background:#ff9800"></div>calls</div>
      <div class="legend-item"><div class="legend-color" style="background:#9c27b0"></div>reads</div>
      <div class="legend-item"><div class="legend-color" style="background:#f44336"></div>writes</div>
      <div class="legend-item"><svg width="20" height="3" style="margin-right:8px"><line x1="0" y1="1.5" x2="20" y2="1.5" stroke="#2196f3" stroke-width="2" stroke-dasharray="4,2"/></svg>internal (within component)</div>
    </div>
    <div class="legend-section">
      <div class="legend-title">Node Types</div>
      <div class="legend-item"><div class="legend-node" style="background:#e94560"></div>Feature</div>
      <div class="legend-item"><div class="legend-node" style="background:#4caf50"></div>Component</div>
      <div class="legend-item"><div class="legend-node" style="background:#607d8b"></div>File</div>
    </div>
    <div class="legend-section">
      <div class="legend-title">Layers (border color)</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #2196f3"></div>interface</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #4caf50"></div>application</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #ff9800"></div>domain</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #9c27b0"></div>infrastructure</div>
    </div>
  </div>

  <div id="footer">
    <div>
      <span class="stat">Nodes: <span id="node-count">0</span></span>
      <span class="stat">Edges: <span id="edge-count">0</span></span>
      <span class="stat health-score">Health: <span id="health-score">--</span>/100</span>
    </div>
    <div>GID CLI - Free Version</div>
  </div>

  <script>
    let graphData = null;
    let layoutData = null;
    let simulation = null;
    let svg = null;
    let g = null;
    let zoom = null;
    let nodes = [];
    let saveTimeout = null;

    // Type-based colors
    const typeColors = {
      Feature: '#e94560',
      Component: '#4caf50',
      Interface: '#ff9800',
      Data: '#9c27b0',
      File: '#607d8b',
      Test: '#00bcd4',
      Decision: '#795548',
    };

    // Layer-based colors (used for File nodes or as border)
    const layerColors = {
      interface: '#2196f3',    // Blue - API/UI layer
      application: '#4caf50',  // Green - Business logic
      domain: '#ff9800',       // Orange - Core domain
      infrastructure: '#9c27b0', // Purple - Database/external
    };

    // Status-based opacity
    const statusOpacity = {
      active: 1.0,
      in_progress: 0.85,
      draft: 0.5,        // Greyer for proposed/draft nodes
      deprecated: 0.4,   // Faded for deprecated
    };

    function getNodeColor(node) {
      // If node has a layer, use layer color (works for File, Component, etc.)
      if (node.layer && layerColors[node.layer]) {
        return layerColors[node.layer];
      }
      return typeColors[node.type] || '#607d8b';
    }

    function getNodeOpacity(node) {
      return statusOpacity[node.status] || 1.0;
    }

    // Track expanded components
    const expandedNodes = new Set();

    function getVisibleNodes() {
      const visibleNodes = [];
      const nodeMap = {};

      for (const [id, data] of Object.entries(graphData.nodes || {})) {
        const savedPos = layoutData.positions?.[id];
        if (expandedNodes.has(id) && data.children && data.children.length > 0) {
          // Add parent as expanded indicator
          const parentNode = {
            id,
            ...data,
            isExpanded: true,
            x: savedPos?.x ?? undefined,
            y: savedPos?.y ?? undefined,
            fx: savedPos?.x ?? undefined,
            fy: savedPos?.y ?? undefined,
          };
          visibleNodes.push(parentNode);
          nodeMap[id] = parentNode;

          // Add children
          for (const child of data.children) {
            const childSavedPos = layoutData.positions?.[child.id];
            const childNode = {
              ...child,
              parentId: id,
              isChild: true,
              x: childSavedPos?.x ?? undefined,
              y: childSavedPos?.y ?? undefined,
              fx: childSavedPos?.x ?? undefined,
              fy: childSavedPos?.y ?? undefined,
            };
            visibleNodes.push(childNode);
            nodeMap[child.id] = childNode;
          }
        } else {
          const node = {
            id,
            ...data,
            hasChildren: data.children && data.children.length > 0,
            x: savedPos?.x ?? undefined,
            y: savedPos?.y ?? undefined,
            fx: savedPos?.x ?? undefined,
            fy: savedPos?.y ?? undefined,
          };
          visibleNodes.push(node);
          nodeMap[id] = node;
        }
      }
      return { visibleNodes, nodeMap };
    }

    function getVisibleLinks(nodeMap) {
      const links = [];
      const addedLinks = new Set();

      // Build file-to-component map for resolving external edges
      const fileToComponent = {};
      for (const [id, data] of Object.entries(graphData.nodes || {})) {
        if (data.children) {
          for (const child of data.children) {
            fileToComponent[child.id] = id;
          }
        }
      }

      // Helper to resolve a file ID to its visible node
      function resolveToVisible(fileId) {
        if (nodeMap[fileId]) return fileId;
        const compId = fileToComponent[fileId];
        if (compId && nodeMap[compId]) return compId;
        return null;
      }

      for (const edge of (graphData.edges || [])) {
        const sourceInMap = nodeMap[edge.from];
        const targetInMap = nodeMap[edge.to];

        if (sourceInMap && targetInMap) {
          const linkKey = edge.from + '->' + edge.to;
          if (!addedLinks.has(linkKey)) {
            links.push({ source: edge.from, target: edge.to, relation: edge.relation });
            addedLinks.add(linkKey);
          }
        }
      }

      // Add edges between expanded children (from stored childEdges)
      for (const [id, data] of Object.entries(graphData.nodes || {})) {
        if (expandedNodes.has(id) && data.childEdges) {
          for (const edge of data.childEdges) {
            const linkKey = edge.from + '->' + edge.to;
            if (!addedLinks.has(linkKey)) {
              links.push({ source: edge.from, target: edge.to, relation: edge.relation, isInternal: true });
              addedLinks.add(linkKey);
            }
          }
        }

        // Add external edges from expanded children to other components
        if (expandedNodes.has(id) && data.childExternalEdges) {
          for (const edge of data.childExternalEdges) {
            const sourceVisible = resolveToVisible(edge.from);
            const targetVisible = resolveToVisible(edge.to);

            if (sourceVisible && targetVisible && sourceVisible !== targetVisible) {
              const linkKey = sourceVisible + '->' + targetVisible;
              if (!addedLinks.has(linkKey)) {
                links.push({ source: sourceVisible, target: targetVisible, relation: edge.relation, isExternal: true });
                addedLinks.add(linkKey);
              }
            }
          }
        }
      }

      return links;
    }

    function toggleExpand(nodeId) {
      if (expandedNodes.has(nodeId)) {
        expandedNodes.delete(nodeId);
      } else {
        expandedNodes.add(nodeId);
      }
      renderGraph();
    }

    // Debounced save function
    function saveLayout() {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        const positions = {};
        nodes.forEach(n => {
          positions[n.id] = { x: n.x, y: n.y };
        });
        const transform = d3.zoomTransform(svg.node());
        fetch('/api/layout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            positions,
            viewport: { zoom: transform.k, panX: transform.x, panY: transform.y }
          })
        }).catch(() => {});
      }, 300);
    }

    function calculateHealthScore() {
      const nodes = graphData.nodes || {};
      const edges = graphData.edges || [];
      const nodeIds = Object.keys(nodes);
      const nodeCount = nodeIds.length;

      if (nodeCount === 0) return 0;

      // Calculate orphan nodes (no incoming or outgoing edges)
      const connectedNodes = new Set();
      edges.forEach(e => {
        connectedNodes.add(e.from);
        connectedNodes.add(e.to);
      });
      const orphanCount = nodeIds.filter(id => !connectedNodes.has(id)).length;

      // Calculate nodes missing layers
      const missingLayerCount = nodeIds.filter(id => {
        const node = nodes[id];
        return node.type === 'File' && !node.layer;
      }).length;

      // Calculate nodes missing descriptions
      const missingDescCount = nodeIds.filter(id => !nodes[id].description).length;

      // Calculate score (100 base, deduct for issues)
      const orphanPenalty = Math.min(30, (orphanCount / nodeCount) * 60);
      const layerPenalty = Math.min(20, (missingLayerCount / nodeCount) * 40);
      const descPenalty = Math.min(15, (missingDescCount / nodeCount) * 30);

      const score = Math.max(0, Math.round(100 - orphanPenalty - layerPenalty - descPenalty));
      return score;
    }

    async function loadGraph() {
      // Load graph and layout in parallel
      const [graphRes, layoutRes] = await Promise.all([
        fetch('/api/graph'),
        fetch('/api/layout')
      ]);
      graphData = await graphRes.json();
      layoutData = await layoutRes.json();

      document.getElementById('node-count').textContent = Object.keys(graphData.nodes || {}).length;
      document.getElementById('edge-count').textContent = (graphData.edges || []).length;
      document.getElementById('health-score').textContent = calculateHealthScore();
      renderGraph();
    }

    function renderGraph() {
      const container = document.getElementById('graph');
      const width = container.clientWidth;
      const height = container.clientHeight;

      container.innerHTML = '';

      svg = d3.select('#graph')
        .append('svg')
        .attr('width', width)
        .attr('height', height);

      zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
          saveLayout(); // Save viewport on zoom/pan
        });

      svg.call(zoom);
      g = svg.append('g');

      // Apply saved viewport if exists
      if (layoutData.viewport && layoutData.viewport.zoom) {
        const { zoom: k, panX: x, panY: y } = layoutData.viewport;
        svg.call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(k));
      }

      const { visibleNodes, nodeMap } = getVisibleNodes();
      nodes = visibleNodes;
      const links = getVisibleLinks(nodeMap);

      const hasSavedLayout = Object.keys(layoutData.positions || {}).length > 0;

      simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(d => d.isInternal ? 60 : 100))
        .force('charge', d3.forceManyBody().strength(d => d.isChild ? -150 : -300))
        .force('center', hasSavedLayout ? null : d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => d.isChild ? 30 : 50));

      // If we have saved layout, stop simulation quickly
      if (hasSavedLayout) {
        simulation.alpha(0.1).alphaDecay(0.1);
      }

      const link = g.append('g')
        .selectAll('line')
        .data(links)
        .join('line')
        .attr('class', d => 'link ' + d.relation + (d.isInternal ? ' internal' : ''))
        .attr('stroke-width', d => d.isInternal ? 1 : 2)
        .attr('stroke-dasharray', d => d.isInternal ? '3,3' : null);

      // Drag behavior
      const drag = d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          // Keep position fixed after drag
          d.fx = d.x;
          d.fy = d.y;
          saveLayout(); // Save on drag end
        });

      const node = g.append('g')
        .selectAll('g')
        .data(nodes)
        .join('g')
        .attr('class', d => 'node' + (d.isChild ? ' child-node' : '') + (d.hasChildren ? ' expandable' : ''))
        .call(drag)
        .on('click', (event, d) => {
          // If in edge creation mode, complete the edge
          if (edgeSourceNode) {
            completeEdge(d);
            return;
          }
          showDetails(d);
        })
        .on('dblclick', (event, d) => {
          event.stopPropagation();
          // If node is expandable, toggle expand; otherwise show edit dialog
          if (d.hasChildren || d.isExpanded) {
            toggleExpand(d.id);
          } else {
            showEditNodeDialog(d);
          }
        })
        .on('contextmenu', (event, d) => {
          event.preventDefault();
          showContextMenu(event, d);
        });

      node.append('circle')
        .attr('r', d => d.isChild ? 15 : 20)
        .attr('fill', d => getNodeColor(d))
        .attr('opacity', d => getNodeOpacity(d))
        .attr('stroke', d => d.layer ? layerColors[d.layer] : (d.hasChildren ? '#fff' : null))
        .attr('stroke-width', d => d.hasChildren ? 3 : (d.layer ? 3 : 2))
        .attr('stroke-dasharray', d => d.hasChildren && !d.isExpanded ? '4,2' : null);

      // Add expand indicator for expandable nodes
      node.filter(d => d.hasChildren && !d.isExpanded)
        .append('text')
        .text('+')
        .attr('text-anchor', 'middle')
        .attr('dy', 5)
        .attr('fill', '#fff')
        .attr('font-size', '16px')
        .attr('font-weight', 'bold')
        .style('pointer-events', 'none');

      // Add collapse indicator for expanded nodes
      node.filter(d => d.isExpanded)
        .append('text')
        .text('−')
        .attr('text-anchor', 'middle')
        .attr('dy', 5)
        .attr('fill', '#fff')
        .attr('font-size', '20px')
        .attr('font-weight', 'bold')
        .style('pointer-events', 'none');

      node.append('text')
        .text(d => d.id.length > 15 ? d.id.substring(0, 12) + '...' : d.id)
        .attr('text-anchor', 'middle')
        .attr('dy', 35)
        .attr('opacity', d => getNodeOpacity(d));

      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
      });
    }

    function showDetails(node) {
      const details = document.getElementById('details');
      document.getElementById('node-name').textContent = node.id;
      const props = document.getElementById('node-properties');
      props.innerHTML = '';
      ['type', 'description', 'layer', 'path', 'status', 'priority'].forEach(key => {
        if (node[key]) {
          props.innerHTML += \`<div class="property"><label>\${key}</label><div>\${node[key]}</div></div>\`;
        }
      });
      details.classList.add('visible');
    }

    function resetZoom() {
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
      // Also reset node positions
      nodes.forEach(n => { n.fx = null; n.fy = null; });
      simulation.alpha(1).restart();
      // Clear saved layout
      fetch('/api/layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions: {}, viewport: {} })
      }).catch(() => {});
    }

    document.getElementById('search').addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      d3.selectAll('.node').each(function(d) {
        const match = d.id.toLowerCase().includes(query);
        d3.select(this).style('opacity', query === '' ? 1 : (match ? 1 : 0.2));
      });
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // Graph Editing Functions (Pro CLI)
    // ═══════════════════════════════════════════════════════════════════════════════

    let hasUnsavedChanges = false;
    let selectedNode = null;
    let contextNode = null;
    let edgeSourceNode = null;

    function setUnsavedChanges(value) {
      hasUnsavedChanges = value;
      const saveBtn = document.getElementById('save-btn');
      const status = document.getElementById('edit-status');
      saveBtn.disabled = !value;
      status.textContent = value ? '● Unsaved changes' : '';
      status.className = 'edit-status' + (value ? ' unsaved' : '');
    }

    // Add Node Dialog
    function showAddNodeDialog() {
      document.getElementById('add-node-dialog').classList.add('visible');
      document.getElementById('overlay').classList.add('visible');
      document.getElementById('new-node-id').focus();
    }

    function hideAddNodeDialog() {
      document.getElementById('add-node-dialog').classList.remove('visible');
      document.getElementById('overlay').classList.remove('visible');
      document.getElementById('new-node-id').value = '';
      document.getElementById('new-node-desc').value = '';
    }

    async function addNode() {
      const id = document.getElementById('new-node-id').value.trim();
      if (!id) {
        alert('Node ID is required');
        return;
      }
      const node = {
        type: document.getElementById('new-node-type').value,
        layer: document.getElementById('new-node-layer').value || undefined,
        description: document.getElementById('new-node-desc').value || undefined,
        status: 'active',
      };
      // Remove undefined fields
      Object.keys(node).forEach(k => node[k] === undefined && delete node[k]);

      try {
        const res = await fetch('/api/graph/node', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, node })
        });
        const data = await res.json();
        if (data.success) {
          hideAddNodeDialog();
          setUnsavedChanges(true);
          await loadGraph();
        } else {
          alert(data.error || 'Failed to add node');
        }
      } catch (err) {
        alert('Failed to add node');
      }
    }

    // Edit Node Dialog
    function showEditNodeDialog(nodeData) {
      selectedNode = nodeData;
      document.getElementById('edit-node-id').textContent = nodeData.id;
      document.getElementById('edit-node-type').value = nodeData.type || 'File';
      document.getElementById('edit-node-layer').value = nodeData.layer || '';
      document.getElementById('edit-node-desc').value = nodeData.description || '';
      document.getElementById('edit-node-status').value = nodeData.status || 'active';
      document.getElementById('edit-node-dialog').classList.add('visible');
      document.getElementById('overlay').classList.add('visible');
    }

    function hideEditNodeDialog() {
      document.getElementById('edit-node-dialog').classList.remove('visible');
      document.getElementById('overlay').classList.remove('visible');
      selectedNode = null;
    }

    async function updateNode() {
      if (!selectedNode) return;
      const node = {
        type: document.getElementById('edit-node-type').value,
        layer: document.getElementById('edit-node-layer').value || undefined,
        description: document.getElementById('edit-node-desc').value || undefined,
        status: document.getElementById('edit-node-status').value,
      };
      Object.keys(node).forEach(k => node[k] === undefined && delete node[k]);

      try {
        const res = await fetch('/api/graph/node/' + encodeURIComponent(selectedNode.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node })
        });
        const data = await res.json();
        if (data.success) {
          hideEditNodeDialog();
          setUnsavedChanges(true);
          await loadGraph();
        } else {
          alert(data.error || 'Failed to update node');
        }
      } catch (err) {
        alert('Failed to update node');
      }
    }

    async function deleteSelectedNode() {
      if (!selectedNode) return;
      if (!confirm('Delete node "' + selectedNode.id + '"? This will also remove connected edges.')) return;

      try {
        const res = await fetch('/api/graph/node/' + encodeURIComponent(selectedNode.id), {
          method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
          hideEditNodeDialog();
          setUnsavedChanges(true);
          await loadGraph();
        } else {
          alert(data.error || 'Failed to delete node');
        }
      } catch (err) {
        alert('Failed to delete node');
      }
    }

    // Context Menu
    function showContextMenu(event, nodeData) {
      event.preventDefault();
      contextNode = nodeData;
      const menu = document.getElementById('context-menu');
      menu.style.left = event.pageX + 'px';
      menu.style.top = event.pageY + 'px';
      menu.classList.add('visible');
    }

    function hideContextMenu() {
      document.getElementById('context-menu').classList.remove('visible');
      contextNode = null;
    }

    function showEditNodeDialogForContext() {
      if (contextNode) {
        showEditNodeDialog(contextNode);
      }
      hideContextMenu();
    }

    async function deleteNodeFromContext() {
      if (!contextNode) return;
      if (!confirm('Delete node "' + contextNode.id + '"?')) {
        hideContextMenu();
        return;
      }
      try {
        const res = await fetch('/api/graph/node/' + encodeURIComponent(contextNode.id), {
          method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
          setUnsavedChanges(true);
          await loadGraph();
        }
      } catch (err) {
        alert('Failed to delete node');
      }
      hideContextMenu();
    }

    // Edge Creation
    function startAddEdge() {
      if (!contextNode) return;
      edgeSourceNode = contextNode;
      hideContextMenu();
      document.getElementById('edge-mode-hint').classList.add('visible');
      d3.selectAll('.node').filter(d => d.id === edgeSourceNode.id).classed('edge-source', true);
    }

    function cancelEdgeMode() {
      edgeSourceNode = null;
      document.getElementById('edge-mode-hint').classList.remove('visible');
      d3.selectAll('.node').classed('edge-source', false);
    }

    async function completeEdge(targetNode) {
      if (!edgeSourceNode || edgeSourceNode.id === targetNode.id) return;

      const relation = prompt('Edge relation (depends_on, implements, calls, reads, writes):', 'depends_on');
      if (!relation) {
        cancelEdgeMode();
        return;
      }

      try {
        const res = await fetch('/api/graph/edge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: edgeSourceNode.id, to: targetNode.id, relation })
        });
        const data = await res.json();
        if (data.success) {
          setUnsavedChanges(true);
          await loadGraph();
        } else {
          alert(data.error || 'Failed to add edge');
        }
      } catch (err) {
        alert('Failed to add edge');
      }
      cancelEdgeMode();
    }

    // Save Graph
    async function saveGraph() {
      try {
        const res = await fetch('/api/graph/save', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          setUnsavedChanges(false);
          alert('Graph saved successfully!');
        } else {
          alert(data.error || 'Failed to save graph');
        }
      } catch (err) {
        alert('Failed to save graph');
      }
    }

    function closeDialogs() {
      hideAddNodeDialog();
      hideEditNodeDialog();
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDialogs();
        hideContextMenu();
        cancelEdgeMode();
      }
      if (e.key === 'Delete' && selectedNode && !document.querySelector('.dialog.visible')) {
        deleteSelectedNode();
      }
    });

    // Close context menu on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.context-menu')) {
        hideContextMenu();
      }
    });

    // Warn before leaving with unsaved changes
    window.addEventListener('beforeunload', (e) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    loadGraph();
  </script>
  <div id="edge-mode-hint" class="edge-mode-hint">Click on a node to create edge. Press Esc to cancel.</div>
</body>
</html>`;
}
