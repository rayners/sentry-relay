/**
 * Input Validation Middleware for Sentry Relay
 * 
 * Provides comprehensive validation and sanitization for all incoming requests
 * to prevent malicious payloads and ensure data integrity.
 */

export interface ValidationConfig {
  /** Maximum request body size in bytes */
  maxBodySize: number;
  /** Maximum string field length */
  maxStringLength: number;
  /** Maximum array length */
  maxArrayLength: number;
  /** Maximum object depth */
  maxObjectDepth: number;
  /** Allowed content types */
  allowedContentTypes: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitizedData?: any;
}

/**
 * Input validator class with configurable rules
 */
export class InputValidator {
  private config: ValidationConfig;

  constructor(config: ValidationConfig) {
    this.config = config;
  }

  /**
   * Get validation configuration from environment variables
   */
  static getConfigFromEnv(env: any): ValidationConfig {
    return {
      maxBodySize: parseInt(env.MAX_REQUEST_SIZE || '1048576', 10), // 1MB default
      maxStringLength: parseInt(env.MAX_STRING_LENGTH || '10000', 10),
      maxArrayLength: parseInt(env.MAX_ARRAY_LENGTH || '100', 10),
      maxObjectDepth: parseInt(env.MAX_OBJECT_DEPTH || '10', 10),
      allowedContentTypes: (env.ALLOWED_CONTENT_TYPES || 'application/json,text/plain').split(',')
    };
  }

  /**
   * Validate request headers and basic structure
   */
  validateRequest(request: Request): ValidationResult {
    const errors: string[] = [];

    // Check content type
    const contentType = request.headers.get('content-type');
    if (contentType && !this.config.allowedContentTypes.some(allowed => contentType.includes(allowed))) {
      errors.push(`Invalid content type: ${contentType}`);
    }

    // Check content length if provided
    const contentLength = request.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (size > this.config.maxBodySize) {
        errors.push(`Request too large: ${size} bytes (max: ${this.config.maxBodySize})`);
      }
    }

    // Check for suspicious headers
    const suspiciousHeaders = [
      'x-forwarded-host',
      'x-original-url',
      'x-rewrite-url'
    ];

    for (const header of suspiciousHeaders) {
      if (request.headers.has(header)) {
        errors.push(`Suspicious header detected: ${header}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate and sanitize JSON payload
   */
  async validateJsonPayload(request: Request): Promise<ValidationResult> {
    try {
      // First validate the request structure
      const requestValidation = this.validateRequest(request);
      if (!requestValidation.valid) {
        return requestValidation;
      }

      // Parse and validate body size
      const body = await request.text();
      if (body.length > this.config.maxBodySize) {
        return {
          valid: false,
          errors: [`Request body too large: ${body.length} characters (max: ${this.config.maxBodySize})`]
        };
      }

      // Parse JSON
      let data: any;
      try {
        data = JSON.parse(body);
      } catch (parseError) {
        return {
          valid: false,
          errors: ['Invalid JSON format']
        };
      }

      // Validate and sanitize the data structure
      const validation = this.validateAndSanitizeObject(data, 'root', 0);
      
      return {
        valid: validation.valid,
        errors: validation.errors,
        sanitizedData: validation.valid ? validation.sanitizedData : undefined
      };

    } catch (error) {
      return {
        valid: false,
        errors: [`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  /**
   * Validate Foundry error report structure
   */
  validateFoundryErrorReport(data: any): ValidationResult {
    const errors: string[] = [];

    // Check required top-level fields
    const requiredFields = ['error', 'attribution', 'meta'];
    for (const field of requiredFields) {
      if (!data[field] || typeof data[field] !== 'object') {
        errors.push(`Missing or invalid required field: ${field}`);
      }
    }

    // Validate error object
    if (data.error) {
      const errorFields = ['message', 'stack', 'type', 'source'];
      for (const field of errorFields) {
        if (!data.error[field] || typeof data.error[field] !== 'string') {
          errors.push(`Missing or invalid error field: error.${field}`);
        }
      }
    }

    // Validate attribution object
    if (data.attribution) {
      const attrFields = ['moduleId', 'confidence', 'method', 'source'];
      for (const field of attrFields) {
        if (!data.attribution[field] || typeof data.attribution[field] !== 'string') {
          errors.push(`Missing or invalid attribution field: attribution.${field}`);
        }
      }
    }

    // Validate meta object
    if (data.meta) {
      const metaFields = ['timestamp', 'privacyLevel', 'reporterVersion'];
      for (const field of metaFields) {
        if (!data.meta[field] || typeof data.meta[field] !== 'string') {
          errors.push(`Missing or invalid meta field: meta.${field}`);
        }
      }

      // Validate timestamp format
      if (data.meta.timestamp && !this.isValidISO8601(data.meta.timestamp)) {
        errors.push('Invalid timestamp format (must be ISO 8601)');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitizedData: errors.length === 0 ? data : undefined
    };
  }

  /**
   * Recursively validate and sanitize object structure
   */
  private validateAndSanitizeObject(obj: any, path: string, depth: number): ValidationResult {
    const errors: string[] = [];

    // Check depth limit
    if (depth > this.config.maxObjectDepth) {
      return {
        valid: false,
        errors: [`Object depth exceeds limit at ${path} (max: ${this.config.maxObjectDepth})`]
      };
    }

    // Handle null or undefined
    if (obj === null || obj === undefined) {
      return { valid: true, errors: [], sanitizedData: obj };
    }

    // Handle primitives
    if (typeof obj === 'string') {
      return this.sanitizeString(obj, path);
    }

    if (typeof obj === 'number') {
      if (!isFinite(obj)) {
        errors.push(`Invalid number at ${path}: ${obj}`);
        return { valid: false, errors };
      }
      return { valid: true, errors: [], sanitizedData: obj };
    }

    if (typeof obj === 'boolean') {
      return { valid: true, errors: [], sanitizedData: obj };
    }

    // Handle arrays
    if (Array.isArray(obj)) {
      if (obj.length > this.config.maxArrayLength) {
        errors.push(`Array too long at ${path}: ${obj.length} items (max: ${this.config.maxArrayLength})`);
        return { valid: false, errors };
      }

      const sanitizedArray: any[] = [];
      for (let i = 0; i < obj.length; i++) {
        const itemValidation = this.validateAndSanitizeObject(obj[i], `${path}[${i}]`, depth + 1);
        if (!itemValidation.valid) {
          errors.push(...itemValidation.errors);
        } else {
          sanitizedArray.push(itemValidation.sanitizedData);
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        sanitizedData: errors.length === 0 ? sanitizedArray : undefined
      };
    }

    // Handle objects
    if (typeof obj === 'object') {
      const sanitizedObject: any = {};
      const keys = Object.keys(obj);

      // Limit number of properties
      if (keys.length > this.config.maxArrayLength) {
        errors.push(`Too many object properties at ${path}: ${keys.length} (max: ${this.config.maxArrayLength})`);
        return { valid: false, errors };
      }

      for (const key of keys) {
        // Validate key
        const keyValidation = this.sanitizeString(key, `${path}.${key}(key)`);
        if (!keyValidation.valid) {
          errors.push(...keyValidation.errors);
          continue;
        }

        // Validate value
        const valueValidation = this.validateAndSanitizeObject(obj[key], `${path}.${key}`, depth + 1);
        if (!valueValidation.valid) {
          errors.push(...valueValidation.errors);
        } else {
          sanitizedObject[keyValidation.sanitizedData] = valueValidation.sanitizedData;
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        sanitizedData: errors.length === 0 ? sanitizedObject : undefined
      };
    }

    // Unsupported type
    errors.push(`Unsupported data type at ${path}: ${typeof obj}`);
    return { valid: false, errors };
  }

  /**
   * Sanitize string input
   */
  private sanitizeString(str: string, path: string): ValidationResult {
    const errors: string[] = [];

    // Check length
    if (str.length > this.config.maxStringLength) {
      errors.push(`String too long at ${path}: ${str.length} characters (max: ${this.config.maxStringLength})`);
      return { valid: false, errors };
    }

    // Check for null bytes and other control characters
    if (str.includes('\0')) {
      errors.push(`Null byte detected in string at ${path}`);
      return { valid: false, errors };
    }

    // Remove/escape potentially dangerous characters
    let sanitized = str
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters except \t, \n, \r
      .replace(/[\uFEFF\uFFFE\uFFFF]/g, ''); // Remove BOM and other problematic Unicode

    // Check for script injection patterns
    const dangerousPatterns = [
      /<script[^>]*>/i,
      /javascript:/i,
      /vbscript:/i,
      /data:text\/html/i,
      /onclick\s*=/i,
      /onerror\s*=/i
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(sanitized)) {
        errors.push(`Potentially malicious content detected at ${path}`);
        return { valid: false, errors };
      }
    }

    return {
      valid: true,
      errors: [],
      sanitizedData: sanitized
    };
  }

  /**
   * Validate ISO 8601 timestamp format
   */
  private isValidISO8601(timestamp: string): boolean {
    const iso8601Regex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z?$/;
    if (!iso8601Regex.test(timestamp)) {
      return false;
    }

    const date = new Date(timestamp);
    return !isNaN(date.getTime());
  }
}

/**
 * Create validation middleware function
 */
export function createValidationMiddleware(config: ValidationConfig) {
  const validator = new InputValidator(config);

  return async function validationMiddleware(
    request: Request,
    corsHeaders: Record<string, string>
  ): Promise<{ response?: Response; validatedData?: any }> {
    
    // Skip validation for health checks and OPTIONS
    const url = new URL(request.url);
    if (url.pathname === '/health' || request.method === 'OPTIONS') {
      return {}; // Allow through
    }

    // Only validate POST requests with body
    if (request.method === 'POST') {
      const validation = await validator.validateJsonPayload(request);
      
      if (!validation.valid) {
        console.warn('Request validation failed:', validation.errors);
        
        const response = new Response(JSON.stringify({
          success: false,
          message: 'Request validation failed',
          errors: validation.errors,
          timestamp: new Date().toISOString(),
          endpoint: 'sentry-relay'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });

        return { response };
      }

      // Additional Foundry-specific validation for error reports
      if (url.pathname.startsWith('/report/')) {
        const foundryValidation = validator.validateFoundryErrorReport(validation.sanitizedData);
        
        if (!foundryValidation.valid) {
          console.warn('Foundry error report validation failed:', foundryValidation.errors);
          
          const response = new Response(JSON.stringify({
            success: false,
            message: 'Invalid Foundry error report format',
            errors: foundryValidation.errors,
            timestamp: new Date().toISOString(),
            endpoint: 'sentry-relay'
          }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });

          return { response };
        }

        return { validatedData: foundryValidation.sanitizedData };
      }

      return { validatedData: validation.sanitizedData };
    }

    return {}; // Allow non-POST requests through
  };
}