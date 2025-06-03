/**
 * Simple test script to verify the worker can send to Sentry
 * 
 * Usage:
 *   SENTRY_DSN=your_sentry_dsn_here node test-worker.js
 */

const SENTRY_DSN = process.env.SENTRY_DSN;

async function testSentryConnection() {
  if (!SENTRY_DSN) {
    console.error('❌ SENTRY_DSN environment variable is required');
    console.log('Usage: SENTRY_DSN=your_sentry_dsn_here node test-worker.js');
    process.exit(1);
  }
  
  console.log('Testing Sentry connection...');
  
  // Create a test event similar to what our worker generates
  const testEvent = {
    event_id: generateEventId(),
    timestamp: new Date().toISOString(),
    platform: 'javascript',
    sdk: {
      name: 'foundry-errors-and-echoes-test',
      version: '1.0.0'
    },
    tags: {
      environment: 'test',
      foundry_version: '12.331',
      module_id: 'test-module',
      attribution_confidence: 'test',
      test: 'connectivity'
    },
    contexts: {
      foundry: {
        version: '12.331'
      },
      test: {
        source: 'worker-test',
        timestamp: new Date().toISOString()
      }
    },
    extra: {
      message: 'Test event from Sentry relay worker',
      worker_version: '1.0.0'
    }
  };

  try {
    const success = await sendToSentry(testEvent, SENTRY_DSN);
    if (success) {
      console.log('✅ Successfully sent test event to Sentry!');
      console.log('Check your Sentry project for the test event.');
    } else {
      console.log('❌ Failed to send test event to Sentry');
    }
  } catch (error) {
    console.error('❌ Error testing Sentry connection:', error);
  }
}

async function sendToSentry(event, dsn) {
  try {
    // Parse Sentry DSN to extract project info
    const dsnMatch = dsn.match(/https:\/\/([^@]+)@([^\/]+)\/(.+)/);
    if (!dsnMatch) {
      console.error('Invalid Sentry DSN format');
      return false;
    }

    const [, key, host, projectId] = dsnMatch;
    const url = `https://${host}/api/${projectId}/store/`;

    console.log(`Sending to: ${url}`);
    console.log(`Project ID: ${projectId}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=sentry-relay-test/1.0.0`
      },
      body: JSON.stringify(event)
    });

    console.log(`Response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Sentry API error:', response.status, errorText);
      return false;
    }

    const responseData = await response.text();
    console.log('Sentry response:', responseData);
    return true;
  } catch (error) {
    console.error('Failed to send to Sentry:', error);
    return false;
  }
}

function generateEventId() {
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/[x]/g, function() {
    return (Math.random() * 16 | 0).toString(16);
  });
}

// Run the test
testSentryConnection();