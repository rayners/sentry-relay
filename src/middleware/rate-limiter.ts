/**
 * Rate Limiting Middleware for Sentry Relay
 * 
 * Implements configurable rate limiting with IP-based throttling
 * to prevent abuse and ensure service stability.
 */

export interface RateLimitConfig {
  /** Maximum requests per window period */
  maxRequests: number;
  /** Window period in seconds */
  windowSeconds: number;
  /** Burst allowance - additional requests allowed in short bursts */
  burstAllowance?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

export interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
    burstCount?: number;
    burstResetTime?: number;
  };
}

/**
 * Rate limiter class that tracks requests per IP address
 */
export class RateLimiter {
  private store: RateLimitStore = {};
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = {
      burstAllowance: 5, // Default burst allowance
      ...config
    };
  }

  /**
   * Check if a request from the given IP is allowed
   */
  checkLimit(ip: string): RateLimitResult {
    const now = Date.now();
    const windowMs = this.config.windowSeconds * 1000;
    const burstWindowMs = 60 * 1000; // 1 minute burst window

    // Clean up expired entries periodically
    this.cleanupExpiredEntries(now);

    // Get or create rate limit entry for this IP
    if (!this.store[ip]) {
      this.store[ip] = {
        count: 0,
        resetTime: now + windowMs,
        burstCount: 0,
        burstResetTime: now + burstWindowMs
      };
    }

    const entry = this.store[ip];

    // Reset window if expired
    if (now >= entry.resetTime) {
      entry.count = 0;
      entry.resetTime = now + windowMs;
    }

    // Reset burst window if expired
    if (now >= (entry.burstResetTime || 0)) {
      entry.burstCount = 0;
      entry.burstResetTime = now + burstWindowMs;
    }

    // Check main rate limit
    if (entry.count >= this.config.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.resetTime,
        retryAfter: Math.ceil((entry.resetTime - now) / 1000)
      };
    }

    // Check burst limit if configured
    if (this.config.burstAllowance && 
        (entry.burstCount || 0) >= this.config.burstAllowance) {
      return {
        allowed: false,
        remaining: Math.max(0, this.config.maxRequests - entry.count),
        resetTime: entry.resetTime,
        retryAfter: Math.ceil(((entry.burstResetTime || now) - now) / 1000)
      };
    }

    // Allow the request - increment counters
    entry.count++;
    entry.burstCount = (entry.burstCount || 0) + 1;

    return {
      allowed: true,
      remaining: Math.max(0, this.config.maxRequests - entry.count),
      resetTime: entry.resetTime
    };
  }

  /**
   * Get rate limit configuration from environment variables
   */
  static getConfigFromEnv(env: any): RateLimitConfig {
    return {
      maxRequests: parseInt(env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
      windowSeconds: parseInt(env.RATE_LIMIT_WINDOW_SECONDS || '3600', 10), // 1 hour default
      burstAllowance: parseInt(env.RATE_LIMIT_BURST_ALLOWANCE || '10', 10)
    };
  }

  /**
   * Extract client IP from request, handling Cloudflare headers
   */
  static getClientIP(request: Request): string {
    // Cloudflare provides the real IP in CF-Connecting-IP header
    const cfIP = request.headers.get('CF-Connecting-IP');
    if (cfIP) return cfIP;

    // Fallback to X-Forwarded-For
    const forwardedFor = request.headers.get('X-Forwarded-For');
    if (forwardedFor) {
      const ips = forwardedFor.split(',');
      return ips[0].trim();
    }

    // Last resort - may not be accurate in production
    const url = new URL(request.url);
    return url.hostname || 'unknown';
  }

  /**
   * Create rate limit headers for response
   */
  static createRateLimitHeaders(result: RateLimitResult): Record<string, string> {
    const headers: Record<string, string> = {
      'X-RateLimit-Limit': `${result.remaining + (result.allowed ? 1 : 0)}`,
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': Math.floor(result.resetTime / 1000).toString()
    };

    if (result.retryAfter) {
      headers['Retry-After'] = result.retryAfter.toString();
    }

    return headers;
  }

  /**
   * Create a 429 Too Many Requests response
   */
  static createRateLimitResponse(result: RateLimitResult, corsHeaders: Record<string, string>): Response {
    const response = {
      success: false,
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: result.retryAfter,
      timestamp: new Date().toISOString(),
      endpoint: 'sentry-relay'
    };

    return new Response(JSON.stringify(response), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        ...this.createRateLimitHeaders(result),
        ...corsHeaders
      }
    });
  }

  /**
   * Remove expired entries from the store to prevent memory leaks
   */
  private cleanupExpiredEntries(now: number): void {
    const ipsToDelete: string[] = [];

    for (const [ip, entry] of Object.entries(this.store)) {
      // Remove entries that are well past their reset time
      if (now > entry.resetTime + (this.config.windowSeconds * 1000)) {
        ipsToDelete.push(ip);
      }
    }

    for (const ip of ipsToDelete) {
      delete this.store[ip];
    }
  }
}

/**
 * Middleware function that checks rate limits for incoming requests
 */
export function createRateLimitMiddleware(config: RateLimitConfig) {
  const rateLimiter = new RateLimiter(config);

  return function rateLimitMiddleware(
    request: Request, 
    corsHeaders: Record<string, string>
  ): Response | null {
    // Skip rate limiting for health checks
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return null; // Allow through
    }

    const ip = RateLimiter.getClientIP(request);
    const result = rateLimiter.checkLimit(ip);

    if (!result.allowed) {
      console.warn(`Rate limit exceeded for IP: ${ip}, retry after: ${result.retryAfter}s`);
      return RateLimiter.createRateLimitResponse(result, corsHeaders);
    }

    // Request is allowed - log for monitoring
    if (result.remaining < 10) {
      console.log(`Rate limit warning for IP: ${ip}, remaining: ${result.remaining}`);
    }

    return null; // Allow request to proceed
  };
}