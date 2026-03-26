/**
 * AI Client Implementations
 *
 * Provides AI client implementations for different providers.
 */

import { AIClient, AIClientConfig, AIMessage, AICompletionOptions, AIProvider } from './types.js';
import { GIDError } from '../core/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// OpenAI Client
// ═══════════════════════════════════════════════════════════════════════════════

class OpenAIClient implements AIClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: AIClientConfig) {
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.model = config.model || 'gpt-4o';

    if (!this.apiKey) {
      throw new GIDError(
        'OpenAI API key not found. Set OPENAI_API_KEY environment variable or pass apiKey in config.',
        'AI_ERROR'
      );
    }
  }

  async complete(prompt: string, options?: AICompletionOptions): Promise<string> {
    const messages: AIMessage[] = [];

    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    return this.chat(messages, options);
  }

  async chat(messages: AIMessage[], options?: AICompletionOptions): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 4096,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new GIDError(`OpenAI API error: ${error}`, 'AI_ERROR');
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content || '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Anthropic Client
// ═══════════════════════════════════════════════════════════════════════════════

class AnthropicClient implements AIClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: AIClientConfig) {
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.model = config.model || 'claude-sonnet-4-20250514';

    if (!this.apiKey) {
      throw new GIDError(
        'Anthropic API key not found. Set ANTHROPIC_API_KEY environment variable or pass apiKey in config.',
        'AI_ERROR'
      );
    }
  }

  async complete(prompt: string, options?: AICompletionOptions): Promise<string> {
    const messages: AIMessage[] = [{ role: 'user', content: prompt }];
    return this.chat(messages, options);
  }

  async chat(messages: AIMessage[], options?: AICompletionOptions): Promise<string> {
    // Extract system message if present
    let systemPrompt = options?.systemPrompt || '';
    const chatMessages = messages.filter((m) => {
      if (m.role === 'system') {
        systemPrompt = m.content;
        return false;
      }
      return true;
    });

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options?.maxTokens ?? 4096,
        system: systemPrompt || undefined,
        messages: chatMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new GIDError(`Anthropic API error: ${error}`, 'AI_ERROR');
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const textBlock = data.content.find((c) => c.type === 'text');
    return textBlock?.text || '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Ollama Client (Local)
// ═══════════════════════════════════════════════════════════════════════════════

class OllamaClient implements AIClient {
  private baseUrl: string;
  private model: string;

  constructor(config: AIClientConfig) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.model = config.model || 'llama3.2';
  }

  async complete(prompt: string, options?: AICompletionOptions): Promise<string> {
    const messages: AIMessage[] = [];

    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    return this.chat(messages, options);
  }

  async chat(messages: AIMessage[], _options?: AICompletionOptions): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new GIDError(`Ollama API error: ${error}`, 'AI_ERROR');
    }

    const data = (await response.json()) as {
      message: { content: string };
    };
    return data.message?.content || '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Factory Function
// ═══════════════════════════════════════════════════════════════════════════════

export function createAIClient(config: AIClientConfig): AIClient {
  switch (config.provider) {
    case 'openai':
      return new OpenAIClient(config);
    case 'anthropic':
      return new AnthropicClient(config);
    case 'ollama':
      return new OllamaClient(config);
    default:
      throw new GIDError(`Unknown AI provider: ${config.provider}`, 'AI_ERROR');
  }
}

/**
 * Detect available AI provider from environment
 */
export function detectAIProvider(): AIProvider | null {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  // Could add check for running Ollama server
  return null;
}
