# Sentry Relay - Reference Implementation for Foundry VTT Error Reporting

⚠️ **SECURITY WARNING: PROOF OF CONCEPT IMPLEMENTATION**
This is a proof-of-concept implementation missing critical security features including:
- Rate limiting and request throttling
- Comprehensive input validation and data sanitization  
- Proper CORS origin validation
- Request size limits

**NOT PRODUCTION-READY**. Use only for development and testing.

A Cloudflare Worker that serves as a reference implementation for receiving error reports from Foundry VTT modules and forwarding them to Sentry. This implementation demonstrates the standard error reporting API that module authors can implement with any backend.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Standard API Specification](#standard-api-specification)
- [Deployment Guide](#deployment-guide)
- [Configuration](#configuration)
- [Testing](#testing)
- [Alternative Implementations](#alternative-implementations)
- [Security Considerations](#security-considerations)

## Architecture Overview

```
Foundry VTT Module → Sentry Relay Worker → Sentry Project
                   ↓
              Standard Response Format
```

**Key Features:**
- **Author-based routing**: Different module authors can have separate Sentry projects
- **Standard response format**: Consistent JSON responses with event IDs
- **CORS support**: Works from any Foundry VTT domain
- **Error transformation**: Converts Foundry error format to Sentry events
- **Health monitoring**: Built-in health check endpoint

## Standard API Specification

This implementation follows a **reference API specification** for Foundry VTT error reporting.

### Endpoints

#### 1. Error Reporting: `POST /report/{author}`

Receives error reports from Foundry VTT modules.

**Request Format:**
```json
{
  "error": {
    "message": "Error description",
    "stack": "Error stack trace",
    "type": "Error",
    "source": "module-name"
  },
  "attribution": {
    "moduleId": "module-name",
    "confidence": "high|medium|low",
    "method": "automatic|manual",
    "source": "stack-trace|user-report"
  },
  "foundry": {
    "version": "12.331",
    "system": {
      "id": "dnd5e",
      "version": "3.0.0"
    },
    "modules": [
      {"id": "module-id", "version": "1.0.0"}
    ],
    "scene": "Scene Name"
  },
  "meta": {
    "timestamp": "2025-06-03T03:47:00.000Z",
    "privacyLevel": "minimal|standard|detailed",
    "reporterVersion": "1.0.0"
  },
  "client": {
    "sessionId": "anonymous-session-id",
    "browser": "Chrome 91.0"
  }
}
```

**Response Format:**
```json
{
  "success": true,
  "eventId": "fc6d8c0c43fc4630ad850ee518f1b9d0",
  "message": "Error report received and processed successfully",
  "timestamp": "2025-06-03T03:47:10.010Z",
  "endpoint": "sentry-relay"
}
```

#### 2. Connectivity Test: `POST /test/{author}`

Tests connectivity to the error reporting backend.

**Request Format:**
```json
{
  "test": true,
  "timestamp": "2025-06-03T03:47:00.000Z",
  "source": "endpoint-test"
}
```

**Response Format:**
```json
{
  "success": true,
  "eventId": "test-event-id",
  "message": "Connectivity test successful for author 'author-name'",
  "timestamp": "2025-06-03T03:47:10.010Z",
  "endpoint": "sentry-relay"
}
```

#### 3. Health Check: `GET /health`

Returns the health status of the service.

**Response Format:**
```json
{
  "status": "healthy",
  "timestamp": "2025-06-03T03:47:10.010Z",
  "service": "sentry-relay"
}
```

### Error Response Format

All endpoints return errors in this standard format:

```json
{
  "success": false,
  "message": "Detailed error description",
  "timestamp": "2025-06-03T03:47:10.010Z",
  "endpoint": "sentry-relay",
  "retryAfter": 300
}
```

## Deployment Guide

### Prerequisites

- Cloudflare account with Workers enabled
- Sentry account with project(s) created
- `wrangler` CLI tool installed

### 1. Setup Project

```bash
# Clone or create your project
mkdir my-error-relay
cd my-error-relay

# Copy the reference implementation
cp -r /path/to/sentry-relay/* .

# Install dependencies
npm install
```

### 2. Configure Environment

Edit `wrangler.toml`:

```toml
name = "your-error-relay"
main = "src/index.ts"
compatibility_date = "2024-12-18"
compatibility_flags = ["nodejs_compat"]

[env.production]
name = "your-error-relay"
routes = [
  { pattern = "errors.yourdomain.com/*", zone_name = "yourdomain.com" }
]

[env.production.vars]
ALLOWED_ORIGINS = "https://yourdomain.com,http://localhost:30000"
```

### 3. Set Sentry Secrets

For each author you want to support:

```bash
# Set Sentry DSN for your modules
echo "https://your-key@your-org.ingest.sentry.io/your-project-id" | \
  npx wrangler secret put SENTRY_DSN_YOURNAME --env production

# Add more authors as needed
echo "https://other-key@org.ingest.sentry.io/other-project" | \
  npx wrangler secret put SENTRY_DSN_OTHERNAME --env production
```

### 4. Deploy Worker

```bash
# Deploy to production
npx wrangler deploy --env production
```

### 5. Configure DNS

In your Cloudflare dashboard, ensure your domain routes to the worker:
- Route: `errors.yourdomain.com/*`
- Worker: `your-error-relay`

## Configuration

### Author-Based Routing

The worker routes errors based on the `{author}` path parameter:

- `/report/yourname` → Uses `SENTRY_DSN_YOURNAME` secret
- `/report/othername` → Uses `SENTRY_DSN_OTHERNAME` secret

**Adding New Authors:**

1. Create a Sentry project for the author
2. Set the secret: `SENTRY_DSN_{UPPERCASE_AUTHOR_NAME}`
3. Deploy the updated worker

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SENTRY_DSN_{AUTHOR}` | Sentry DSN for author's modules | `https://key@org.ingest.sentry.io/project` |
| `ALLOWED_ORIGINS` | CORS allowed origins | `https://domain.com,http://localhost:30000` |

### CORS Configuration

The worker automatically handles CORS for all origins by default (`ALLOWED_ORIGINS = "*"`). This allows error reports from any Foundry VTT instance worldwide. 

For additional security, you can restrict to specific origins:
- Set `ALLOWED_ORIGINS` to specific domains: `"https://your-domain.com,http://localhost:30000"`
- Use `"*"` (default) to allow all origins for maximum compatibility

## Testing

### 1. Health Check

```bash
curl https://errors.yourdomain.com/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2025-06-03T03:47:10.010Z",
  "service": "sentry-relay"
}
```

### 2. Connectivity Test

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"test": true, "timestamp": "2025-06-03T03:47:00.000Z", "source": "manual-test"}' \
  https://errors.yourdomain.com/test/yourname
```

### 3. Error Report Test

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "error": {
      "message": "Test error from manual testing",
      "stack": "Error: Test\n    at test.js:1:1",
      "type": "Error",
      "source": "manual-test"
    },
    "attribution": {
      "moduleId": "test-module",
      "confidence": "high",
      "method": "manual",
      "source": "user-report"
    },
    "foundry": {
      "version": "12.331"
    },
    "meta": {
      "timestamp": "2025-06-03T03:47:00.000Z",
      "privacyLevel": "full",
      "reporterVersion": "1.0.0"
    }
  }' \
  https://errors.yourdomain.com/report/yourname
```

## Alternative Implementations

While this reference implementation uses Sentry, the same API can be implemented with other backends:

### Discord Webhook Implementation

```javascript
// Example: Forward errors to Discord
export default {
  async fetch(request, env) {
    const webhookUrl = env.DISCORD_WEBHOOK_URL;
    
    if (url.pathname.startsWith('/report/')) {
      const errorReport = await request.json();
      
      // Transform to Discord message
      const discordMessage = {
        embeds: [{
          title: `🚨 Error in ${errorReport.attribution.moduleId}`,
          description: errorReport.error.message,
          color: 0xff0000,
          timestamp: errorReport.meta.timestamp
        }]
      };
      
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordMessage)
      });
      
      return new Response(JSON.stringify({
        success: true,
        eventId: crypto.randomUUID(),
        message: "Error forwarded to Discord",
        timestamp: new Date().toISOString(),
        endpoint: "discord-webhook"
      }));
    }
  }
}
```

### Database Storage Implementation

```javascript
// Example: Store errors in a database
export default {
  async fetch(request, env) {
    if (url.pathname.startsWith('/report/')) {
      const errorReport = await request.json();
      const eventId = crypto.randomUUID();
      
      // Store in database (Cloudflare D1, PostgreSQL, etc.)
      await env.DB.prepare(`
        INSERT INTO error_reports (id, module_id, message, stack, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        eventId,
        errorReport.attribution.moduleId,
        errorReport.error.message,
        errorReport.error.stack,
        errorReport.meta.timestamp
      ).run();
      
      return new Response(JSON.stringify({
        success: true,
        eventId,
        message: "Error stored in database",
        timestamp: new Date().toISOString(),
        endpoint: "database-storage"
      }));
    }
  }
}
```

### Email Notification Implementation

```javascript
// Example: Send errors via email
export default {
  async fetch(request, env) {
    if (url.pathname.startsWith('/report/')) {
      const errorReport = await request.json();
      
      // Send email (using service like SendGrid, Mailgun, etc.)
      const emailBody = `
        Error in module: ${errorReport.attribution.moduleId}
        Message: ${errorReport.error.message}
        Foundry Version: ${errorReport.foundry.version}
        Time: ${errorReport.meta.timestamp}
        
        Stack Trace:
        ${errorReport.error.stack}
      `;
      
      await sendEmail({
        to: env.DEVELOPER_EMAIL,
        subject: `🚨 Error in ${errorReport.attribution.moduleId}`,
        body: emailBody
      });
      
      return new Response(JSON.stringify({
        success: true,
        eventId: `email-${Date.now()}`,
        message: "Error emailed to developer",
        timestamp: new Date().toISOString(),
        endpoint: "email-notifications"
      }));
    }
  }
}
```

## Security Considerations

⚠️ **Note**: The following security features are planned but not yet implemented in this proof-of-concept.

### 1. Input Validation (Planned)

Always validate incoming data:

```javascript
function validateErrorReport(report) {
  if (!report.error?.message) {
    throw new Error('Missing error message');
  }
  if (!report.attribution?.moduleId) {
    throw new Error('Missing module ID');
  }
  if (!report.meta?.timestamp) {
    throw new Error('Missing timestamp');
  }
  // Add more validation as needed
}
```

### 2. Rate Limiting (Planned)

Implement rate limiting to prevent abuse:

```javascript
// Example: Simple rate limiting
const rateLimiter = new Map();

function checkRateLimit(clientIP, limit = 10, window = 60000) {
  const now = Date.now();
  const requests = rateLimiter.get(clientIP) || [];
  
  // Remove old requests
  const recentRequests = requests.filter(time => now - time < window);
  
  if (recentRequests.length >= limit) {
    return false; // Rate limited
  }
  
  recentRequests.push(now);
  rateLimiter.set(clientIP, recentRequests);
  return true;
}
```

### 3. CORS Configuration (Partially Implemented)

Be specific with CORS origins:

```javascript
function getCORSHeaders(env) {
  const allowedOrigins = env.ALLOWED_ORIGINS?.split(',') || [];
  
  return {
    'Access-Control-Allow-Origin': allowedOrigins.join(','),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Foundry-Version',
    'Access-Control-Max-Age': '86400'
  };
}
```

### 4. Sensitive Data Handling (Planned)

Never log or store sensitive information:

```javascript
function sanitizeErrorReport(report) {
  // Remove potential sensitive data
  const sanitized = { ...report };
  
  // Remove user-specific information
  delete sanitized.client?.userId;
  delete sanitized.client?.username;
  
  // Sanitize stack traces of file paths
  if (sanitized.error?.stack) {
    sanitized.error.stack = sanitized.error.stack
      .replace(/\/Users\/[^\/]+/g, '/Users/***')
      .replace(/C:\\Users\\[^\\]+/g, 'C:\\Users\\***');
  }
  
  return sanitized;
}
```

## Contributing

This reference implementation is designed to be:
- **Extensible**: Easy to add new backends or modify behavior
- **Reference compliant**: Follows the reference error reporting API
- **Well-documented**: Clear examples for other developers
- **Basic Security**: Proof-of-concept with planned security features

When contributing:
1. Maintain API compatibility
2. Add comprehensive tests
3. Update documentation
4. Follow security best practices

## License

This reference implementation is provided under the MIT License to encourage adoption and modification by the Foundry VTT community.

---

**Need Help?**
- Check the [Errors and Echoes Documentation](https://github.com/rayners/fvtt-errors-and-echoes)
- Review the module's API examples and integration guides
- Join the community discussion on Discord