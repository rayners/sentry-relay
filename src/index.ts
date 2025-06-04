/**
 * Sentry Relay Cloudflare Worker
 * 
 * Receives error reports from Foundry VTT modules and forwards them to Sentry
 * with proper formatting, security controls, and author-based project routing.
 */

import { createRateLimitMiddleware, RateLimiter } from './middleware/rate-limiter';
import { createValidationMiddleware, InputValidator } from './middleware/input-validator';

export interface Env {
  // Sentry DSNs for different authors (set as secrets)
  SENTRY_DSN_RAYNERS?: string;
  // Add more DSNs as needed: SENTRY_DSN_OTHER_AUTHOR?: string;
  
  // Configuration variables
  ALLOWED_ORIGINS?: string;
  
  // Rate limiting configuration
  RATE_LIMIT_MAX_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  RATE_LIMIT_BURST_ALLOWANCE?: string;
  
  // Input validation configuration
  MAX_REQUEST_SIZE?: string;
  MAX_STRING_LENGTH?: string;
  MAX_ARRAY_LENGTH?: string;
  MAX_OBJECT_DEPTH?: string;
  ALLOWED_CONTENT_TYPES?: string;
}

interface ErrorReportResponse {
  success: boolean;
  eventId?: string;          // Unique identifier for this error report
  message?: string;          // Human-readable status message
  timestamp?: string;        // ISO timestamp when the error was processed
  endpoint?: string;         // Endpoint that processed the request
  retryAfter?: number;       // Seconds to wait before retrying (for rate limiting)
}

interface FoundryErrorReport {
  error: {
    message: string;
    stack: string;
    type: string;
    source: string;
  };
  attribution: {
    moduleId: string;
    confidence: string;
    method: string;
    source: string;
  };
  foundry: {
    version: string;
    system?: {
      id: string;
      version: string;
    };
    modules?: Array<{
      id: string;
      version: string;
    }>;
    scene?: string;
  };
  meta: {
    timestamp: string;
    privacyLevel: string;
    reporterVersion: string;
  };
  client?: {
    sessionId?: string;
    browser?: string;
  };
  moduleContext?: Record<string, any>;
}

interface SentryEvent {
  event_id: string;
  timestamp: string;
  platform: string;
  sdk: {
    name: string;
    version: string;
  };
  exception?: {
    values: Array<{
      type: string;
      value: string;
      stacktrace?: {
        frames: Array<{
          filename: string;
          function: string;
          lineno?: number;
          colno?: number;
        }>;
      };
    }>;
  };
  tags: Record<string, string>;
  contexts: Record<string, any>;
  extra: Record<string, any>;
  user?: {
    id?: string;
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Get CORS headers early for consistent usage
    const corsHeaders = getCORSHeaders(env, request);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request, env);
    }

    // Initialize security middlewares
    const rateLimitConfig = RateLimiter.getConfigFromEnv(env);
    const rateLimitMiddleware = createRateLimitMiddleware(rateLimitConfig);
    
    const validationConfig = InputValidator.getConfigFromEnv(env);
    const validationMiddleware = createValidationMiddleware(validationConfig);

    // Apply rate limiting
    const rateLimitResponse = rateLimitMiddleware(request, corsHeaders);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    // Apply input validation
    const validationResult = await validationMiddleware(request, corsHeaders);
    if (validationResult.response) {
      return validationResult.response;
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Route handling
      if (path.startsWith('/report/')) {
        return handleErrorReport(request, env, path, validationResult.validatedData);
      } else if (path.startsWith('/test/')) {
        return handleEndpointTest(request, env, path, validationResult.validatedData);
      } else if (path === '/health') {
        return handleHealthCheck(env, request);
      } else {
        return new Response('Not Found', { 
          status: 404,
          headers: corsHeaders
        });
      }
    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal Server Error', { 
        status: 500,
        headers: corsHeaders
      });
    }
  }
};

async function handleErrorReport(request: Request, env: Env, path: string, validatedData?: any): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: getCORSHeaders(env)
    });
  }

  // Extract author from path: /report/{author}
  const author = path.split('/')[2];
  if (!author) {
    return new Response('Invalid endpoint path', { 
      status: 400,
      headers: getCORSHeaders(env)
    });
  }

  // Get Sentry DSN for this author
  const sentryDSN = getSentryDSN(author, env);
  if (!sentryDSN) {
    console.warn(`No Sentry DSN configured for author: ${author}`);
    return new Response('Author not configured', { 
      status: 404,
      headers: getCORSHeaders(env)
    });
  }

  try {
    // Use validated data if available, otherwise parse request
    let foundryReport: FoundryErrorReport;
    if (validatedData) {
      foundryReport = validatedData;
    } else {
      foundryReport = await request.json();
      
      // Basic validation if data wasn't pre-validated
      if (!foundryReport.error || !foundryReport.attribution || !foundryReport.meta) {
        return createStandardResponse(false, {
          message: 'Invalid error report format: missing required fields',
          status: 400
        });
      }
    }

    // Convert to Sentry format
    const sentryEvent = transformToSentryEvent(foundryReport);
    
    // Send to Sentry
    const eventId = await sendToSentry(sentryEvent, sentryDSN);
    
    if (eventId) {
      return createStandardResponse(true, {
        eventId,
        message: 'Error report received and processed successfully'
      });
    } else {
      return createStandardResponse(false, {
        message: 'Failed to forward error report to monitoring service',
        status: 502
      });
    }
  } catch (error) {
    console.error('Error processing report:', error);
    return createStandardResponse(false, {
      message: 'Invalid request format or processing error',
      status: 400
    });
  }
}

async function handleEndpointTest(request: Request, env: Env, path: string, validatedData?: any): Promise<Response> {
  if (request.method !== 'POST') {
    return createStandardResponse(false, {
      message: 'Method Not Allowed',
      status: 405
    });
  }

  // Extract author from path: /test/{author}
  const author = path.split('/')[2];
  if (!author) {
    return createStandardResponse(false, {
      message: 'Invalid test endpoint path',
      status: 400
    });
  }

  // Check if Sentry DSN is configured for this author
  const sentryDSN = getSentryDSN(author, env);
  if (!sentryDSN) {
    return createStandardResponse(false, {
      message: `No configuration found for author '${author}'`,
      status: 404
    });
  }

  try {
    // Use validated data if available, otherwise parse request
    const testData = validatedData || await request.json();
    
    // Create a test Sentry event
    const testEvent: SentryEvent = {
      event_id: generateEventId(),
      timestamp: new Date().toISOString(),
      platform: 'javascript',
      sdk: {
        name: 'sentry-relay-test',
        version: '1.0.0'
      },
      tags: {
        environment: 'test',
        author: author,
        test: 'connectivity'
      },
      contexts: {
        test: {
          source: 'foundry-module-test',
          timestamp: testData.timestamp || new Date().toISOString()
        }
      },
      extra: {
        message: 'Connectivity test from Foundry VTT module',
        testData
      }
    };

    // Send test event to Sentry
    const eventId = await sendToSentry(testEvent, sentryDSN);
    
    if (eventId) {
      return createStandardResponse(true, {
        eventId,
        message: `Connectivity test successful for author '${author}'`
      });
    } else {
      return createStandardResponse(false, {
        message: `Test failed: Could not send to monitoring service for author '${author}'`,
        status: 502
      });
    }
  } catch (error) {
    console.error('Test endpoint error:', error);
    return createStandardResponse(false, {
      message: `Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      status: 400
    });
  }
}

async function handleHealthCheck(env?: Env, request?: Request): Promise<Response> {
  return new Response(JSON.stringify({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'sentry-relay'
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...getCORSHeaders(env, request)
    }
  });
}

function handleCORS(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: getCORSHeaders(env, request)
  });
}

function getCORSHeaders(env?: Env, request?: Request): Record<string, string> {
  const allowedOrigins = env?.ALLOWED_ORIGINS?.split(',').map(origin => origin.trim()) || ['*'];
  
  // Determine the appropriate origin header
  let allowOrigin = '*';
  let allowCredentials = 'false';
  
  // If wildcard is explicitly allowed, use it
  if (allowedOrigins.includes('*')) {
    allowOrigin = '*';
    allowCredentials = 'false';
  } else if (request && allowedOrigins.length > 0) {
    // Check if request origin is in allowed list
    const requestOrigin = request.headers.get('Origin');
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      allowOrigin = requestOrigin;
      allowCredentials = 'true';
    } else {
      // Request from non-allowed origin - still allow but without credentials
      allowOrigin = '*';
      allowCredentials = 'false';
    }
  }
  
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Foundry-Version, X-Module-Version, X-Privacy-Level, User-Agent, Origin, Accept',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': allowCredentials
  };
}

function getSentryDSN(author: string, env: Env): string | undefined {
  // Map authors to their Sentry DSN environment variables
  const dsnMap: Record<string, keyof Env> = {
    'rayners': 'SENTRY_DSN_RAYNERS',
    // Add more authors as needed
  };

  const dsnKey = dsnMap[author];
  return dsnKey ? env[dsnKey] : undefined;
}

function transformToSentryEvent(foundryReport: FoundryErrorReport): SentryEvent {
  const sentryEvent: SentryEvent = {
    event_id: generateEventId(),
    timestamp: foundryReport.meta.timestamp,
    platform: 'javascript',
    sdk: {
      name: 'foundry-errors-and-echoes',
      version: foundryReport.meta.reporterVersion
    },
    tags: {
      environment: 'foundry-vtt',
      foundry_version: foundryReport.foundry.version,
      module_id: foundryReport.attribution.moduleId,
      attribution_confidence: foundryReport.attribution.confidence,
      attribution_method: foundryReport.attribution.method,
      privacy_level: foundryReport.meta.privacyLevel,
      error_source: foundryReport.attribution.source
    },
    contexts: {
      foundry: {
        version: foundryReport.foundry.version,
        system: foundryReport.foundry.system,
        scene: foundryReport.foundry.scene
      },
      attribution: foundryReport.attribution,
      runtime: {
        name: 'foundry-vtt',
        version: foundryReport.foundry.version
      }
    },
    extra: {
      moduleContext: foundryReport.moduleContext,
      modules: foundryReport.foundry.modules
    }
  };

  // Add user context if available
  if (foundryReport.client?.sessionId) {
    sentryEvent.user = {
      id: foundryReport.client.sessionId
    };
  }

  // Add browser info if available
  if (foundryReport.client?.browser) {
    sentryEvent.tags.browser = foundryReport.client.browser;
  }

  // Add exception information
  if (foundryReport.error) {
    sentryEvent.exception = {
      values: [{
        type: foundryReport.error.type,
        value: foundryReport.error.message,
        stacktrace: foundryReport.error.stack ? parseStackTrace(foundryReport.error.stack) : undefined
      }]
    };
  }

  return sentryEvent;
}

function parseStackTrace(stack: string): { frames: Array<any> } | undefined {
  try {
    const lines = stack.split('\n');
    const frames = [];

    for (const line of lines) {
      // Parse stack trace lines - this is a simplified parser
      const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
      if (match) {
        frames.push({
          function: match[1],
          filename: match[2],
          lineno: parseInt(match[3], 10),
          colno: parseInt(match[4], 10)
        });
      }
    }

    return frames.length > 0 ? { frames: frames.reverse() } : undefined;
  } catch (error) {
    console.warn('Failed to parse stack trace:', error);
    return undefined;
  }
}

async function sendToSentry(event: SentryEvent, dsn: string): Promise<string | null> {
  try {
    // Parse Sentry DSN to extract project info
    const dsnMatch = dsn.match(/https:\/\/([^@]+)@([^\/]+)\/(.+)/);
    if (!dsnMatch) {
      console.error('Invalid Sentry DSN format');
      return null;
    }

    const [, key, host, projectId] = dsnMatch;
    const url = `https://${host}/api/${projectId}/store/`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=sentry-relay/1.0.0`
      },
      body: JSON.stringify(event)
    });

    if (!response.ok) {
      console.error('Sentry API error:', response.status, await response.text());
      return null;
    }

    // Parse Sentry response to extract event ID
    try {
      const responseData = await response.json() as { id?: string };
      const eventId = responseData.id;
      console.log('Successfully sent event to Sentry, ID:', eventId);
      return eventId || 'unknown';
    } catch (parseError) {
      console.warn('Could not parse Sentry response, but request was successful');
      return 'unknown';
    }
  } catch (error) {
    console.error('Failed to send to Sentry:', error);
    return null;
  }
}

function createStandardResponse(
  success: boolean, 
  options: {
    eventId?: string;
    message?: string;
    retryAfter?: number;
    status?: number;
  } = {}
): Response {
  const response: ErrorReportResponse = {
    success,
    timestamp: new Date().toISOString(),
    endpoint: 'sentry-relay'
  };

  if (options.eventId) response.eventId = options.eventId;
  if (options.message) response.message = options.message;
  if (options.retryAfter) response.retryAfter = options.retryAfter;

  return new Response(JSON.stringify(response), {
    status: options.status || (success ? 200 : 400),
    headers: {
      'Content-Type': 'application/json',
      ...getCORSHeaders()
    }
  });
}

function generateEventId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}