/**
 * GID Semantify Command
 *
 * Upgrade file-level graphs to semantic graphs with layers, components, and features.
 *
 * Two modes:
 * - Heuristic mode (default): Pattern matching based on paths and keywords
 * - AI mode (--ai): True semantic understanding via AI analysis of docs + code
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { loadGraph, saveGraph, findGraphFile } from '../core/parser.js';
import { getFileSignatures, detectFilePatterns, type FileSignatures, type DetectedPattern } from '../analyzers/code-analysis.js';
import { createStateManager } from '../core/state.js';
import { gatherSemanticContext, buildSemanticPrompt, parseSemanticResponse, type SemanticProposal as AISemanticProposal } from '../core/semantic-context.js';
import { createAIClient, detectAIProvider } from '../ai/client.js';
import type { GIDGraph, GIDNode } from '../core/types.js';
import type { AIProvider } from '../ai/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface SemanticProposal {
  type: 'assign_layer' | 'upgrade_to_component' | 'link_to_feature' | 'add_feature' | 'add_description';
  nodeId: string;
  current?: Record<string, unknown>;
  proposed: Record<string, unknown>;
  reason: string;
  confidence: number;
}

interface SemantifyOptions {
  scope?: 'layers' | 'components' | 'features' | 'all';
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  graphPath?: string;
  // AI mode options
  ai?: boolean;
  aiProvider?: string;
  aiModel?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer Proposal Logic
// ═══════════════════════════════════════════════════════════════════════════════

function proposeLayer(
  patterns: DetectedPattern[],
  filePath: string
): { layer: string; reason: string; confidence: number } | null {
  const pathLower = filePath.toLowerCase();

  // ─────────────────────────────────────────────────────────────────────────────
  // Interface layer: User-facing entry points (CLI commands, API routes, UI)
  // ─────────────────────────────────────────────────────────────────────────────
  if (pathLower.includes('/commands/') || pathLower.includes('/cmd/')) {
    return { layer: 'interface', reason: 'CLI commands are interface layer', confidence: 0.9 };
  }
  if (pathLower.includes('/api/') || pathLower.includes('/routes/') || pathLower.includes('/controllers/')) {
    return { layer: 'interface', reason: 'Path indicates API/route layer', confidence: 0.85 };
  }
  if (pathLower.includes('/components/') || pathLower.includes('/ui/') || pathLower.includes('/views/')) {
    return { layer: 'interface', reason: 'Path indicates UI layer', confidence: 0.85 };
  }
  if (pathLower.includes('/web/') || pathLower.includes('/pages/')) {
    return { layer: 'interface', reason: 'Path indicates web interface layer', confidence: 0.85 };
  }
  if (pathLower.includes('/handlers/') || pathLower.includes('/endpoints/')) {
    return { layer: 'interface', reason: 'Path indicates handler/endpoint layer', confidence: 0.85 };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Application layer: Use cases, services, orchestration
  // ─────────────────────────────────────────────────────────────────────────────
  if (pathLower.includes('/services/') || pathLower.includes('/usecases/')) {
    return { layer: 'application', reason: 'Path indicates service/usecase layer', confidence: 0.85 };
  }
  if (pathLower.includes('/analyzers/') || pathLower.includes('/processors/')) {
    return { layer: 'application', reason: 'Path indicates analyzer/processor layer', confidence: 0.8 };
  }
  if (pathLower.includes('/ai/') || pathLower.includes('/llm/')) {
    return { layer: 'application', reason: 'Path indicates AI integration layer', confidence: 0.8 };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Domain layer: Core business logic, types, entities
  // ─────────────────────────────────────────────────────────────────────────────
  if (pathLower.includes('/core/') || pathLower.includes('/lib/')) {
    return { layer: 'domain', reason: 'Path indicates core/lib domain layer', confidence: 0.85 };
  }
  if (pathLower.includes('/domain/') || pathLower.includes('/entities/') || pathLower.includes('/models/')) {
    return { layer: 'domain', reason: 'Path indicates domain layer', confidence: 0.85 };
  }
  if (pathLower.includes('/types/') || pathLower.match(/\/[^/]*types?\.(ts|js)$/)) {
    return { layer: 'domain', reason: 'Type definitions are domain layer', confidence: 0.8 };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Infrastructure layer: External interfaces (DB, filesystem, network)
  // ─────────────────────────────────────────────────────────────────────────────
  if (pathLower.includes('/extractors/') || pathLower.includes('/parsers/')) {
    return { layer: 'infrastructure', reason: 'Path indicates extractor/parser infrastructure', confidence: 0.85 };
  }
  if (pathLower.includes('/infrastructure/') || pathLower.includes('/db/') || pathLower.includes('/repositories/')) {
    return { layer: 'infrastructure', reason: 'Path indicates infrastructure layer', confidence: 0.85 };
  }
  if (pathLower.includes('/adapters/') || pathLower.includes('/clients/')) {
    return { layer: 'infrastructure', reason: 'Path indicates adapter/client infrastructure', confidence: 0.85 };
  }
  if (pathLower.includes('/config/') || pathLower.includes('/settings/')) {
    return { layer: 'infrastructure', reason: 'Path indicates config infrastructure', confidence: 0.8 };
  }

  // Pattern-based inference
  for (const { pattern, confidence } of patterns) {
    switch (pattern) {
      case 'controller':
      case 'middleware':
      case 'react-component':
        return { layer: 'interface', reason: `Detected ${pattern} pattern`, confidence: confidence * 0.9 };
      case 'service':
        return { layer: 'application', reason: 'Detected service pattern', confidence: confidence * 0.9 };
      case 'entity':
      case 'types':
        return { layer: 'domain', reason: `Detected ${pattern} pattern`, confidence: confidence * 0.9 };
      case 'repository':
      case 'config':
        return { layer: 'infrastructure', reason: `Detected ${pattern} pattern`, confidence: confidence * 0.9 };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Component Proposal Logic
// ═══════════════════════════════════════════════════════════════════════════════

function proposeComponent(
  patterns: DetectedPattern[],
  signatures: FileSignatures,
  nodeId: string
): { metadata: Record<string, unknown>; reason: string; confidence: number } | null {
  // Files with classes or multiple exported functions are good component candidates
  if (signatures.classes.length > 0) {
    const primaryPattern = patterns[0]?.pattern;
    return {
      metadata: {
        description: `Component based on ${signatures.classes.length} class(es)`,
        pattern: primaryPattern,
      },
      reason: 'File contains class definitions',
      confidence: 0.8,
    };
  }

  if (signatures.exports.length >= 3) {
    return {
      metadata: {
        description: `Component with ${signatures.exports.length} exports`,
      },
      reason: 'File has multiple exports indicating a cohesive module',
      confidence: 0.7,
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature Proposal Logic
// ═══════════════════════════════════════════════════════════════════════════════

function inferFeatureName(nodeId: string): string | null {
  // Extract potential feature name from node ID
  const parts = nodeId.split(/[-_/]/);
  const significant = parts.filter(p =>
    !['controller', 'service', 'handler', 'manager', 'index', 'utils'].includes(p.toLowerCase())
  );

  if (significant.length > 0) {
    // Capitalize first letter
    const name = significant[significant.length - 1];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  return null;
}

function proposeFeature(
  patterns: DetectedPattern[],
  signatures: FileSignatures,
  nodeId: string
): { feature: string; reason: string; confidence: number } | null {
  // Look for patterns that suggest feature implementation
  for (const { pattern, confidence } of patterns) {
    if (['controller', 'service'].includes(pattern)) {
      // Try to infer feature name from node ID
      const featureName = inferFeatureName(nodeId);
      if (featureName) {
        return {
          feature: featureName,
          reason: `${pattern} pattern suggests feature implementation`,
          confidence: confidence * 0.7,
        };
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI Semantic Analysis
// ═══════════════════════════════════════════════════════════════════════════════

async function analyzeGraphWithAI(
  graph: GIDGraph,
  graphPath: string,
  options: { aiProvider?: string; aiModel?: string }
): Promise<SemanticProposal[]> {
  const proposals: SemanticProposal[] = [];

  // Detect or use specified AI provider
  const providerName = options.aiProvider || detectAIProvider();
  if (!providerName) {
    throw new Error(
      'No AI provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or use --ai-provider.'
    );
  }

  console.log(`\n🤖 Using AI provider: ${providerName}${options.aiModel ? ` (${options.aiModel})` : ''}`);

  // Gather semantic context
  const projectRoot = path.dirname(graphPath);
  console.log('📚 Gathering semantic context from docs and code...');

  const context = gatherSemanticContext(
    { nodes: graph.nodes as Record<string, any>, edges: graph.edges },
    { projectRoot }
  );

  console.log(`   Found ${context.docs.length} documentation files`);
  console.log(`   Found ${context.identifiers.length} code identifiers`);
  console.log(`   Graph has ${context.graphSummary.nodeCount} nodes, ${context.graphSummary.edgeCount} edges`);

  // Build prompt
  const prompt = buildSemanticPrompt(context);

  // Call AI
  console.log('\n🧠 Analyzing with AI...');
  const client = createAIClient({
    provider: providerName as AIProvider,
    model: options.aiModel,
  });

  const response = await client.complete(prompt, {
    systemPrompt: 'You are a software architect analyzing a codebase to understand its semantic structure. Respond only with valid JSON.',
    maxTokens: 4096,
    temperature: 0.3,
  });

  // Parse response
  const aiProposals = parseSemanticResponse(response);
  if (!aiProposals) {
    console.error('⚠️  Could not parse AI response. Falling back to heuristic mode.');
    return [];
  }

  // Convert AI proposals to SemanticProposal format
  // Add features
  for (const feature of aiProposals.features) {
    proposals.push({
      type: 'add_feature',
      nodeId: feature.name,
      proposed: {
        name: feature.name,
        description: feature.description,
        components: feature.components,
      },
      reason: `AI identified feature: ${feature.description}`,
      confidence: 0.85,
    });
  }

  // Add layer assignments
  for (const assignment of aiProposals.layerAssignments) {
    // Only propose if node exists and doesn't have layer
    if (graph.nodes[assignment.nodeId] && !graph.nodes[assignment.nodeId].layer) {
      proposals.push({
        type: 'assign_layer',
        nodeId: assignment.nodeId,
        proposed: { layer: assignment.layer },
        reason: assignment.reason,
        confidence: 0.9,
      });
    }
  }

  // Add descriptions
  for (const desc of aiProposals.descriptions) {
    // Only propose if node exists and doesn't have description
    if (graph.nodes[desc.nodeId] && !graph.nodes[desc.nodeId].description) {
      proposals.push({
        type: 'add_description',
        nodeId: desc.nodeId,
        proposed: { description: desc.description },
        reason: 'AI-generated description',
        confidence: 0.8,
      });
    }
  }

  return proposals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Heuristic Semantify Logic (Fallback)
// ═══════════════════════════════════════════════════════════════════════════════

function analyzeGraph(graph: GIDGraph, scope: string): SemanticProposal[] {
  const proposals: SemanticProposal[] = [];

  // Analyze nodes to propose semantic upgrades
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    // Skip nodes without paths (e.g., Features, abstract nodes)
    if (!node.path) continue;

    try {
      const patterns = detectFilePatterns(node.path);
      const signatures = getFileSignatures(node.path);

      // Propose layer assignment
      if ((scope === 'layers' || scope === 'all') && !node.layer) {
        const layerProposal = proposeLayer(patterns, node.path);
        if (layerProposal) {
          proposals.push({
            type: 'assign_layer',
            nodeId,
            proposed: { layer: layerProposal.layer },
            reason: layerProposal.reason,
            confidence: layerProposal.confidence,
          });
        }
      }

      // Propose component grouping (upgrade File to Component)
      if ((scope === 'components' || scope === 'all') && node.type === 'File') {
        const componentProposal = proposeComponent(patterns, signatures, nodeId);
        if (componentProposal) {
          proposals.push({
            type: 'upgrade_to_component',
            nodeId,
            current: { type: 'File' },
            proposed: { type: 'Component', ...componentProposal.metadata },
            reason: componentProposal.reason,
            confidence: componentProposal.confidence,
          });
        }
      }

      // Propose feature detection
      if (scope === 'features' || scope === 'all') {
        const featureProposal = proposeFeature(patterns, signatures, nodeId);
        if (featureProposal) {
          proposals.push({
            type: 'link_to_feature',
            nodeId,
            proposed: { feature: featureProposal.feature, relation: 'implements' },
            reason: featureProposal.reason,
            confidence: featureProposal.confidence,
          });
        }
      }
    } catch {
      // Skip files that can't be analyzed
    }
  }

  // Sort by confidence (highest first)
  proposals.sort((a, b) => b.confidence - a.confidence);

  return proposals;
}

function applyProposals(graph: GIDGraph, proposals: SemanticProposal[]): number {
  let appliedCount = 0;

  for (const proposal of proposals) {
    switch (proposal.type) {
      case 'assign_layer': {
        const node = graph.nodes[proposal.nodeId];
        if (!node) continue;
        const proposed = proposal.proposed as { layer: string };
        node.layer = proposed.layer as 'interface' | 'application' | 'domain' | 'infrastructure';
        appliedCount++;
        break;
      }
      case 'upgrade_to_component': {
        const node = graph.nodes[proposal.nodeId];
        if (!node) continue;
        const proposed = proposal.proposed as { type: string; description?: string; pattern?: string };
        node.type = 'Component';
        if (proposed.description) node.description = proposed.description;
        appliedCount++;
        break;
      }
      case 'link_to_feature': {
        const node = graph.nodes[proposal.nodeId];
        if (!node) continue;
        const proposed = proposal.proposed as { feature: string; relation: string };
        // Create feature node if it doesn't exist
        const featureId = `Feature:${proposed.feature}`;
        if (!graph.nodes[featureId]) {
          graph.nodes[featureId] = {
            type: 'Feature',
            description: `${proposed.feature} feature`,
            status: 'active',
          };
        }
        // Add implements edge
        graph.edges.push({
          from: proposal.nodeId,
          to: featureId,
          relation: 'implements',
        });
        appliedCount++;
        break;
      }
      case 'add_feature': {
        const proposed = proposal.proposed as { name: string; description: string; components: string[] };
        const featureId = `Feature:${proposed.name}`;
        // Create feature node
        if (!graph.nodes[featureId]) {
          graph.nodes[featureId] = {
            type: 'Feature',
            description: proposed.description,
            status: 'active',
          };
          appliedCount++;
        }
        // Link components to feature
        for (const compId of proposed.components) {
          if (graph.nodes[compId]) {
            // Check if edge already exists
            const edgeExists = graph.edges.some(
              e => e.from === compId && e.to === featureId && e.relation === 'implements'
            );
            if (!edgeExists) {
              graph.edges.push({
                from: compId,
                to: featureId,
                relation: 'implements',
              });
              appliedCount++;
            }
          }
        }
        break;
      }
      case 'add_description': {
        const node = graph.nodes[proposal.nodeId];
        if (!node) continue;
        const proposed = proposal.proposed as { description: string };
        node.description = proposed.description;
        appliedCount++;
        break;
      }
    }
  }

  return appliedCount;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Interactive Approval
// ═══════════════════════════════════════════════════════════════════════════════

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Display Functions
// ═══════════════════════════════════════════════════════════════════════════════

function formatProposal(proposal: SemanticProposal, index: number): string {
  const confidencePct = Math.round(proposal.confidence * 100);
  const confidenceBar = '█'.repeat(Math.round(proposal.confidence * 10)) + '░'.repeat(10 - Math.round(proposal.confidence * 10));

  let typeLabel: string;
  let changeDesc: string;

  switch (proposal.type) {
    case 'assign_layer':
      typeLabel = '🏷️  Layer';
      changeDesc = `→ ${(proposal.proposed as { layer: string }).layer}`;
      break;
    case 'upgrade_to_component':
      typeLabel = '📦 Component';
      changeDesc = 'File → Component';
      break;
    case 'link_to_feature':
      typeLabel = '⭐ Feature';
      changeDesc = `→ implements ${(proposal.proposed as { feature: string }).feature}`;
      break;
    case 'add_feature': {
      typeLabel = '✨ New Feature';
      const proposed = proposal.proposed as { name: string; components: string[] };
      changeDesc = `${proposed.name} (${proposed.components.length} components)`;
      break;
    }
    case 'add_description':
      typeLabel = '📝 Description';
      changeDesc = `"${((proposal.proposed as { description: string }).description).slice(0, 50)}..."`;
      break;
    default:
      typeLabel = '❓ Unknown';
      changeDesc = '';
  }

  return `
  ${index + 1}. ${typeLabel} ${changeDesc}
     Node: ${proposal.nodeId}
     Reason: ${proposal.reason}
     Confidence: ${confidenceBar} ${confidencePct}%`;
}

function displaySummary(proposals: SemanticProposal[], aiMode: boolean): void {
  const layers = proposals.filter(p => p.type === 'assign_layer').length;
  const components = proposals.filter(p => p.type === 'upgrade_to_component').length;
  const featureLinks = proposals.filter(p => p.type === 'link_to_feature').length;
  const newFeatures = proposals.filter(p => p.type === 'add_feature').length;
  const descriptions = proposals.filter(p => p.type === 'add_description').length;

  console.log('\n📊 Proposal Summary:');
  console.log(`   Mode:                 ${aiMode ? '🤖 AI Semantic' : '📏 Heuristic'}`);
  console.log(`   Layer assignments:    ${layers}`);
  console.log(`   Component upgrades:   ${components}`);
  if (newFeatures > 0) {
    console.log(`   New features:         ${newFeatures}`);
  }
  if (featureLinks > 0) {
    console.log(`   Feature links:        ${featureLinks}`);
  }
  if (descriptions > 0) {
    console.log(`   Descriptions:         ${descriptions}`);
  }
  console.log(`   Total:                ${proposals.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Command
// ═══════════════════════════════════════════════════════════════════════════════

export async function runSemantify(options: SemantifyOptions): Promise<void> {
  const graphPath = options.graphPath ?? findGraphFile();
  if (!graphPath) {
    console.error('❌ No graph.yml found. Run `gid init` or `gid extract` first.');
    process.exit(1);
  }

  const scope = options.scope ?? 'all';
  const dryRun = options.dryRun ?? false;
  const autoApprove = options.yes ?? false;
  const useAI = options.ai ?? false;

  // Load graph
  const graph = loadGraph(graphPath);

  let proposals: SemanticProposal[] = [];

  if (useAI) {
    // AI Semantic Mode
    console.log(`\n🧠 Running AI semantic analysis...`);
    try {
      proposals = await analyzeGraphWithAI(graph, graphPath, {
        aiProvider: options.aiProvider,
        aiModel: options.aiModel,
      });

      if (proposals.length === 0) {
        console.log('\n⚠️  AI analysis returned no proposals. Falling back to heuristic mode.');
        proposals = analyzeGraph(graph, scope);
      }
    } catch (error) {
      console.error(`\n⚠️  AI analysis failed: ${error instanceof Error ? error.message : error}`);
      console.log('   Falling back to heuristic mode...\n');
      proposals = analyzeGraph(graph, scope);
    }
  } else {
    // Heuristic Mode
    console.log(`\n🔍 Analyzing graph for semantic upgrades (scope: ${scope}, mode: heuristic)...`);
    proposals = analyzeGraph(graph, scope);
  }

  if (proposals.length === 0) {
    console.log('\n✅ No semantic upgrades needed. Graph is already semantic!');
    return;
  }

  // Output as JSON if requested
  if (options.json) {
    console.log(JSON.stringify({
      mode: useAI ? 'ai' : 'heuristic',
      proposals,
      summary: {
        layers: proposals.filter(p => p.type === 'assign_layer').length,
        components: proposals.filter(p => p.type === 'upgrade_to_component').length,
        features: proposals.filter(p => p.type === 'link_to_feature' || p.type === 'add_feature').length,
        descriptions: proposals.filter(p => p.type === 'add_description').length,
        total: proposals.length,
      },
    }, null, 2));
    return;
  }

  // Display proposals
  console.log('\n📋 Proposed Changes:');
  for (let i = 0; i < Math.min(proposals.length, 20); i++) {
    console.log(formatProposal(proposals[i], i));
  }

  if (proposals.length > 20) {
    console.log(`\n   ... and ${proposals.length - 20} more proposals`);
  }

  displaySummary(proposals, useAI);

  // Dry run mode - just show proposals
  if (dryRun) {
    console.log('\n🔄 Dry run mode - no changes applied.');
    console.log('   Run without --dry-run to apply changes.');
    return;
  }

  // Get user approval
  if (!autoApprove) {
    const answer = await promptUser('\n❓ Apply these changes? [y/N] ');
    if (answer !== 'y' && answer !== 'yes') {
      console.log('❌ Aborted.');
      return;
    }
  }

  // Apply proposals
  const appliedCount = applyProposals(graph, proposals);

  // Save graph
  saveGraph(graph, graphPath);

  // Save to history
  const gidDir = path.dirname(graphPath);
  const stateManager = createStateManager(gidDir);
  stateManager.saveHistory(graph);

  console.log(`\n✅ Applied ${appliedCount} semantic upgrades.`);
  console.log(`   Graph saved to: ${graphPath}`);
  console.log('\n💡 Tip: Run `gid visual --serve` to visualize the semantic graph.');
}
