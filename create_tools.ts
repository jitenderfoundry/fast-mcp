import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import * as yaml from 'js-yaml';

interface PostProcessorConfig {
  maxLength?: number;
  truncateAt?: 'words' | 'characters' | 'lines';
  preserveFormatting?: boolean;
}

interface ResponseParserConfig {
  enabled?: boolean;
  fields?: string[];
  format?: 'json' | 'text';
  fallbackToFullResponse?: boolean;
}

function postProcessOutput(text: string, config: PostProcessorConfig = {}): string {
  const {
    maxLength = 2000,
    truncateAt = 'characters',
    preserveFormatting = true
  } = config;

  if (text.length <= maxLength) {
    return text;
  }

  let truncated: string;

  switch (truncateAt) {
    case 'words':
      const words = text.split(/\s+/);
      const wordLimit = Math.floor(maxLength / 6); // Rough estimate: 6 chars per word
      truncated = words.slice(0, wordLimit).join(' ');
      break;
    
    case 'lines':
      const lines = text.split('\n');
      const lineLimit = Math.floor(maxLength / 50); // Rough estimate: 50 chars per line
      truncated = lines.slice(0, lineLimit).join('\n');
      break;
    
    case 'characters':
    default:
      truncated = text.substring(0, maxLength);
      break;
  }

  // Add truncation indicator
  const indicator = '\n\n[Output truncated for brevity...]';
  const finalLength = truncated.length + indicator.length;
  
  if (finalLength > maxLength) {
    truncated = truncated.substring(0, maxLength - indicator.length);
  }

  return truncated + indicator;
}

function parseResponse(responseText: string, config: ResponseParserConfig = {}): string {
  const {
    enabled = false,
    fields = [],
    format = 'text',
    fallbackToFullResponse = true
  } = config;

  if (!enabled || fields.length === 0) {
    return responseText;
  }

  try {
    // Try to parse as JSON
    const jsonResponse = JSON.parse(responseText);
    
    if (format === 'json') {
      // Extract specified fields and return as JSON
      const extractedData: Record<string, any> = {};
      fields.forEach(field => {
        if (field in jsonResponse) {
          extractedData[field] = jsonResponse[field];
        }
      });
      return JSON.stringify(extractedData, null, 2);
    } else {
      // Extract specified fields and return as formatted text
      const extractedTexts: string[] = [];
      fields.forEach(field => {
        if (field in jsonResponse) {
          const value = jsonResponse[field];
          if (typeof value === 'string') {
            extractedTexts.push(`${field}: ${value}`);
          } else if (typeof value === 'object') {
            extractedTexts.push(`${field}: ${JSON.stringify(value, null, 2)}`);
          } else {
            extractedTexts.push(`${field}: ${String(value)}`);
          }
        }
      });
      return extractedTexts.join('\n\n');
    }
  } catch (error) {
    // If JSON parsing fails, return original response or fallback
    if (fallbackToFullResponse) {
      return responseText;
    } else {
      return `Error parsing JSON response: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
}

interface VariableConfig {
  required?: boolean;
  default?: string;
}

interface RequestTemplate {
  URL: string;
  METHOD: string;
  HEADERS?: (string | Record<string, string>)[];
  BODY?: string;
}

interface YamlConfig {
  name: string;
  variables: Record<string, VariableConfig>;
  request_template: RequestTemplate;
  post_processor?: PostProcessorConfig;
  response_parser?: ResponseParserConfig;
}

export function parseYamlConfig(content: string): YamlConfig {
  try {
    const parsed = yaml.load(content) as any;
    
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid YAML content');
    }
    
    if (!parsed.request_template) {
      throw new Error('Missing request_template in YAML config');
    }
    
    
    const config: YamlConfig = {
      name: parsed.name || '',
      variables: parsed.variables || {},
      request_template: {
        URL: parsed.request_template.URL || '',
        METHOD: parsed.request_template.METHOD || 'GET',
        HEADERS: parsed.request_template.HEADERS || [],
        BODY: parsed.request_template.BODY || ''
      },
      post_processor: parsed.post_processor || undefined,
      response_parser: parsed.response_parser || undefined
    };
    
    return config;
  } catch (error) {
    console.error('Error parsing YAML:', error);
    throw new Error(`Failed to parse YAML config: ${error}`);
  }
}

export async function createToolFromConfig(config: YamlConfig, server: any) {
  const toolName = config.name.replace(/[^a-zA-Z0-9_]/g, '_');
  const parameters: Record<string, any> = {};
  
  // Create Zod schema for all variables
  Object.entries(config.variables).forEach(([variableName, varConfig]) => {
    const isRequired = varConfig.required !== false; // Default to required if not specified
    
    if (isRequired) {
      parameters[variableName] = z.string().describe(`The ${variableName} parameter`);
    } else {
      parameters[variableName] = z.string().optional().describe(`The ${variableName} parameter (optional)`);
    }
  });
  
  
  server.tool(
    "get_answer_from_collection",
    config.name,
    parameters,
    async (args: Record<string, string>) => {
      console.error(`${toolName} tool called`, args);
      
      try {
        // Replace variables in the request template
        let url = config.request_template.URL;
        let body = config.request_template.BODY || '';
        
        Object.entries(config.variables).forEach(([varName, varConfig]) => {
          let value = args[varName];
          
          // If no value provided, use default or empty string
          if (value === undefined || value === null) {
            value = varConfig.default || '';
          }
          
          // Replace variables in URL and body
          url = url.replace(new RegExp(`{${varName}}`, 'g'), value);
          body = body.replace(new RegExp(`{${varName}}`, 'g'), value);
        });
        
        // Clean up the body - remove surrounding quotes if present
        if (body.startsWith("'") && body.endsWith("'")) {
          body = body.slice(1, -1);
        } else if (body.startsWith('"') && body.endsWith('"')) {
          body = body.slice(1, -1);
        }
        
        
        // Build headers object
        const headers: Record<string, string> = {};
        if (config.request_template.HEADERS) {
          config.request_template.HEADERS.forEach(header => {
            if (typeof header === 'string') {
              const [key, value] = header.split(':').map(s => s.trim());
              if (key && value) {
                headers[key] = value;
              }
            } else if (typeof header === 'object' && header !== null) {
              // Handle object format headers
              Object.entries(header).forEach(([key, value]) => {
                if (typeof value === 'string') {
                  headers[key] = value;
                }
              });
            }
          });
        }
        
        // Build fetch options
        const options: RequestInit = {
          method: config.request_template.METHOD,
          headers: headers
        };
        
        // Add body if present and method supports it
        if (body && ['POST', 'PUT', 'PATCH'].includes(config.request_template.METHOD)) {
          options.body = body;
        }
        
        // Execute the fetch request
        const response = await fetch(url, options);
        
        let responseText = '';
        try {
          responseText = await response.text();
        } catch (e) {
          responseText = `Response status: ${response.status} ${response.statusText}`;
        }
        
        // Apply response parser to extract specific fields
        const parsedResponseText = parseResponse(responseText, config.response_parser);
        
        // Apply post processor to reduce output size
        const fullResponseText = `Request executed successfully:\n\nStatus: ${response.status} ${response.statusText}\n\nResponse:\n${parsedResponseText}`;
        const processedText = postProcessOutput(fullResponseText, config.post_processor);
        
        return {
          content: [
            {
              type: "text",
              text: processedText,
            },
          ],
        };
      } catch (error: any) {
        const errorText = `Error executing request: ${error.message}`;
        const processedErrorText = postProcessOutput(errorText, config.post_processor);
        
        return {
          content: [
            {
              type: "text",
              text: processedErrorText,
            },
          ],
        };
      }
    }
  );
}

export function createCollectionsTool(server: any) {
  server.tool(
    "get_available_collections",
    "Get available collections from environment variables",
    {},
    async () => {
      console.error("get_available_collections tool called");
      
      try {
        const collections: Array<{name: string, description: string}> = [];
        
        // Get collections from a single JSON environment variable
        const collectionsJson = process.env.COLLECTIONS;
        
        if (!collectionsJson) {
          return {
            content: [
              {
                type: "text",
                text: 'No collections found. Please set the COLLECTIONS environment variable with a JSON map of collections.\n\nExpected format:\n{\n  "collection1": "Description 1",\n  "collection2": "Description 2"\n}',
              },
            ],
          };
        }
        
        try {
          const collectionsMap = JSON.parse(collectionsJson);
          
          // Convert the map to an array of collection objects
          Object.entries(collectionsMap).forEach(([name, description]) => {
            collections.push({
              name: name,
              description: typeof description === 'string' ? description : 'No description available'
            });
          });
          
          // Sort collections by name
          collections.sort((a, b) => a.name.localeCompare(b.name));
          
          const responseText = collections.length > 0 
            ? `Available Collections:\n\n${collections.map(c => `• ${c.name}: ${c.description}`).join('\n')}`
            : 'No valid collections found in the COLLECTIONS environment variable.';
          
          return {
            content: [
              {
                type: "text",
                text: responseText,
              },
            ],
          };
        } catch (parseError) {
          return {
            content: [
              {
                type: "text",
                text: `Error parsing COLLECTIONS JSON: ${parseError instanceof Error ? parseError.message : 'Invalid JSON format'}\n\nExpected format:\n{\n  "collection1": "Description 1",\n  "collection2": "Description 2"\n}`,
              },
            ],
          };
        }
      } catch (error: any) {
        const errorText = `Error fetching collections: ${error.message}`;
        
        return {
          content: [
            {
              type: "text",
              text: errorText,
            },
          ],
        };
      }
    }
  );
}

export async function loadToolsFromConfigs(server: any) {
  try {
    const endpointsDir = join(process.cwd(), 'config', 'endpoints');
    const yamlFiles = readdirSync(endpointsDir).filter(file => file.endsWith('.yaml'));
    
    for (const yamlFile of yamlFiles) {
      const filePath = join(endpointsDir, yamlFile);
      const content = readFileSync(filePath, 'utf-8');
      const config = parseYamlConfig(content);
      await createToolFromConfig(config, server);
      console.error(`Loaded tool: ${config.name}`);
    }
  } catch (error) {
    console.error('Error loading tools from configs:', error);
  }
}


