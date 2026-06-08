import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { cache } from 'hono/cache';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

// =============================================
// Types & Schemas
// =============================================
const EarthquakeSchema = z.object({
  date: z.string(),
  time: z.string(),
  latitude: z.string(),
  longitude: z.string(),
  depth: z.number(),
  magnitude: z.string(),
  location: z.string(),
  magnitudeNumeric: z.number()
});

type EarthquakeData = z.infer<typeof EarthquakeSchema>;

interface CacheEntry {
  data: EarthquakeData[];
  timestamp: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// =============================================
// Constants
// =============================================
const PHIVOLCS_URL = 'https://earthquake.phivolcs.dost.gov.ph/';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOP_COUNT = 50;
const REQUEST_TIMEOUT = 15000;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 requests per minute

// =============================================
// In-Memory Cache & Rate Limiting
// =============================================
let earthquakeCache: CacheEntry | null = null;
const rateLimitMap = new Map<string, RateLimitEntry>();

// =============================================
// Helper Functions
// =============================================
function parseMagnitude(mag: string): number {
  const parsed = parseFloat(mag);
  return isNaN(parsed) ? 0 : parsed;
}

function parseDepth(depth: string): number {
  const parsed = parseInt(depth, 10);
  return isNaN(parsed) ? 0 : parsed;
}

function parseCoordinate(coord: string): number {
  const parsed = parseFloat(coord);
  return isNaN(parsed) ? 0 : parsed;
}

function isCacheValid(): boolean {
  if (!earthquakeCache) return false;
  return Date.now() - earthquakeCache.timestamp < CACHE_TTL_MS;
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

async function fetchEarthquakes(forceRefresh = false): Promise<EarthquakeData[]> {
  // Return cached data if valid and not forcing refresh
  if (!forceRefresh && isCacheValid() && earthquakeCache) {
    return earthquakeCache.data;
  }

  try {
    const response = await axios.get(PHIVOLCS_URL, {
      httpsAgent: new (require('https').Agent)({ 
        rejectUnauthorized: false 
      }),
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent': 'PHIVOLCS-API-Client/2.0'
      }
    });

    const $ = cheerio.load(response.data);
    const $table = $('table.MsoNormalTable');
    const earthquakes: EarthquakeData[] = [];

    if ($table.length === 0) {
      throw new Error('Earthquake data table not found on page');
    }

    $table.find('tr').each((_, row) => {
      const $row = $(row);
      const $cols = $row.find('td');
      
      if ($cols.length < 6) return;
      
      const $dateLink = $cols.eq(0).find('a');
      const [date = '', time = ''] = $dateLink.length 
        ? $dateLink.text().trim().split(' - ') 
        : [];

      const magnitudeStr = $cols.eq(4).text().trim();
      const magnitudeNumeric = parseMagnitude(magnitudeStr);
      const depthStr = $cols.eq(3).text().trim();
      const depthNumeric = parseDepth(depthStr);

      const earthquake = {
        date: date.trim(),
        time: time.trim(),
        latitude: $cols.eq(1).text().trim(),
        longitude: $cols.eq(2).text().trim(),
        depth: depthNumeric,
        magnitude: magnitudeStr,
        location: $cols.eq(5).text().replace(/\s+/g, ' ').trim(),
        magnitudeNumeric
      };

      // Validate all required fields
      if (earthquake.date && earthquake.time && earthquake.magnitude && earthquake.location) {
        earthquakes.push(earthquake);
      }
    });

    if (earthquakes.length === 0) {
      throw new Error('No valid earthquake data found');
    }

    // Update cache
    earthquakeCache = {
      data: earthquakes,
      timestamp: Date.now()
    };

    return earthquakes;
  } catch (error) {
    // If cache exists but expired, return it anyway on error
    if (earthquakeCache) {
      console.warn('Failed to fetch fresh data, returning stale cache');
      return earthquakeCache.data;
    }
    throw error;
  }
}

function filterByMagnitude(earthquakes: EarthquakeData[], minMag?: number, maxMag?: number): EarthquakeData[] {
  return earthquakes.filter(eq => {
    const mag = eq.magnitudeNumeric;
    if (minMag !== undefined && mag < minMag) return false;
    if (maxMag !== undefined && mag > maxMag) return false;
    return true;
  });
}

function filterByLocation(earthquakes: EarthquakeData[], location: string): EarthquakeData[] {
  const searchTerm = location.toLowerCase();
  return earthquakes.filter(eq => 
    eq.location.toLowerCase().includes(searchTerm)
  );
}

function filterByDepth(earthquakes: EarthquakeData[], minDepth?: number, maxDepth?: number): EarthquakeData[] {
  return earthquakes.filter(eq => {
    const d = eq.depth;
    if (minDepth !== undefined && d < minDepth) return false;
    if (maxDepth !== undefined && d > maxDepth) return false;
    return true;
  });
}

// =============================================
// App Initialization
// =============================================
const app = new Hono();

// =============================================
// Middleware
// =============================================
app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 86400
}));

// Rate limiting middleware
app.use('*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() 
    || c.req.header('x-real-ip') 
    || 'unknown';
  
  const { allowed, remaining, retryAfter } = checkRateLimit(ip);
  
  c.header('X-RateLimit-Remaining', String(remaining));
  c.header('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
  
  if (!allowed) {
    c.header('Retry-After', String(retryAfter || 60));
    return c.json(
      { 
        success: false, 
        error: { 
          message: 'Rate limit exceeded', 
          retryAfter: retryAfter || 60 
        } 
      },
      { status: 429 }
    );
  }
  
  await next();
});

// Cache headers middleware for data endpoints
app.use('/earthquakes*', async (c, next) => {
  await next();
  c.header('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
});

// =============================================
// Routes
// =============================================
app.get('/', (c) => {
  return c.json({
    name: 'PHIVOLCS Earthquake API',
    version: '2.1.0',
    description: 'RESTful API for Philippine earthquake data from PHIVOLCS',
    endpoints: {
      '/': 'API documentation',
      '/earthquakes': 'Get all recent earthquakes (paginated)',
      '/earthquakes/top/:count': 'Get top N earthquakes by magnitude',
      '/earthquakes/recent/:count': 'Get N most recent earthquakes',
      '/earthquakes/filter': 'Filter earthquakes by magnitude, depth, or location',
      '/earthquakes/stats': 'Get earthquake statistics',
      '/health': 'API health check'
    },
    filter_params: {
      minMagnitude: 'Minimum magnitude (number)',
      maxMagnitude: 'Maximum magnitude (number)',
      minDepth: 'Minimum depth in km (number)',
      maxDepth: 'Maximum depth in km (number)',
      location: 'Location search term (string, case-insensitive)'
    },
    pagination_params: {
      page: 'Page number (default: 1)',
      limit: 'Results per page (default: 50, max: 100)'
    },
    cache_ttl: `${CACHE_TTL_MS / 1000}s`,
    rate_limit: `${RATE_LIMIT_MAX} requests per minute`,
    source: 'https://earthquake.phivolcs.dost.gov.ph/'
  });
});

app.get('/health', async (c) => {
  try {
    const earthquakes = await fetchEarthquakes();
    return c.json({
      status: 'healthy',
      cache_valid: isCacheValid(),
      last_update: earthquakeCache?.timestamp 
        ? new Date(earthquakeCache.timestamp).toISOString() 
        : null,
      data_count: earthquakes.length
    });
  } catch (error) {
    return c.json(
      {
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 503 }
    );
  }
});

app.get(
  '/earthquakes',
  zValidator(
    'query',
    z.object({
      page: z.string().optional().transform(v => v ? parseInt(v, 10) : 1),
      limit: z.string().optional().transform(v => v ? parseInt(v, 10) : 50)
    }).transform(data => ({
      page: Math.max(1, data.page),
      limit: Math.min(100, Math.max(1, data.limit))
    }))
  ),
  async (c) => {
    const { page, limit } = c.req.valid('query');
    
    try {
      const allEarthquakes = await fetchEarthquakes();
      const total = allEarthquakes.length;
      const totalPages = Math.ceil(total / limit);
      const start = (page - 1) * limit;
      const earthquakes = allEarthquakes.slice(start, start + limit);
      
      return c.json({
        meta: {
          timestamp: new Date().toISOString(),
          count: earthquakes.length,
          total,
          page,
          limit,
          totalPages,
          cache_age_seconds: earthquakeCache 
            ? Math.floor((Date.now() - earthquakeCache.timestamp) / 1000)
            : 0
        },
        data: earthquakes
      });
    } catch (error) {
      console.error('Error fetching earthquakes:', error);
      return c.json(
        { 
          error: 'Failed to fetch earthquake data',
          message: error instanceof Error ? error.message : 'Unknown error'
        },
        { status: 500 }
      );
    }
  }
);

app.get(
  '/earthquakes/top/:count',
  zValidator(
    'param',
    z.object({
      count: z
        .string()
        .regex(/^\d+$/, 'Count must be a positive number')
        .transform(Number)
        .refine((n: number) => n > 0 && n <= MAX_TOP_COUNT, 
          `Count must be between 1 and ${MAX_TOP_COUNT}`)
    })
  ),
  async (c) => {
    const { count } = c.req.valid('param');
    
    try {
      const earthquakes = await fetchEarthquakes();
      const topEarthquakes = [...earthquakes]
        .sort((a, b) => b.magnitudeNumeric - a.magnitudeNumeric)
        .slice(0, count);

      return c.json({
        meta: {
          timestamp: new Date().toISOString(),
          count: topEarthquakes.length,
          requested: count,
          total_available: earthquakes.length
        },
        data: topEarthquakes
      });
    } catch (error) {
      console.error('Error fetching top earthquakes:', error);
      return c.json(
        { 
          error: 'Failed to fetch top earthquakes',
          message: error instanceof Error ? error.message : 'Unknown error'
        },
        { status: 500 }
      );
    }
  }
);

app.get(
  '/earthquakes/recent/:count',
  zValidator(
    'param',
    z.object({
      count: z
        .string()
        .regex(/^\d+$/, 'Count must be a positive number')
        .transform(Number)
        .refine((n: number) => n > 0 && n <= MAX_TOP_COUNT, 
          `Count must be between 1 and ${MAX_TOP_COUNT}`)
    })
  ),
  async (c) => {
    const { count } = c.req.valid('param');
    
    try {
      const earthquakes = await fetchEarthquakes();
      const recentEarthquakes = earthquakes.slice(0, count);

      return c.json({
        meta: {
          timestamp: new Date().toISOString(),
          count: recentEarthquakes.length,
          requested: count
        },
        data: recentEarthquakes
      });
    } catch (error) {
      console.error('Error fetching recent earthquakes:', error);
      return c.json(
        { 
          error: 'Failed to fetch recent earthquakes',
          message: error instanceof Error ? error.message : 'Unknown error'
        },
        { status: 500 }
      );
    }
  }
);

// FIXED: Filter endpoint — accepts both camelCase and snake_case, depth filtering added
app.get(
  '/earthquakes/filter',
  zValidator(
    'query',
    z.object({
      // Accept both camelCase and snake_case for magnitude
      minMagnitude: z.string().optional().transform(v => v ? parseFloat(v) : undefined),
      maxMagnitude: z.string().optional().transform(v => v ? parseFloat(v) : undefined),
      min_magnitude: z.string().optional().transform(v => v ? parseFloat(v) : undefined),
      max_magnitude: z.string().optional().transform(v => v ? parseFloat(v) : undefined),
      // Depth filtering (new)
      minDepth: z.string().optional().transform(v => v ? parseFloat(v) : undefined),
      maxDepth: z.string().optional().transform(v => v ? parseFloat(v) : undefined),
      min_depth: z.string().optional().transform(v => v ? parseFloat(v) : undefined),
      max_depth: z.string().optional().transform(v => v ? parseFloat(v) : undefined),
      // Location
      location: z.string().optional()
    })
  ),
  async (c) => {
    const query = c.req.valid('query');
    
    // Merge camelCase + snake_case (camelCase takes precedence)
    const minMag = query.minMagnitude ?? query.min_magnitude;
    const maxMag = query.maxMagnitude ?? query.max_magnitude;
    const minDp = query.minDepth ?? query.min_depth;
    const maxDp = query.maxDepth ?? query.max_depth;
    const loc = query.location;
    
    try {
      let earthquakes = await fetchEarthquakes();
      
      // Apply filters independently (AND logic)
      if (minMag !== undefined || maxMag !== undefined) {
        earthquakes = filterByMagnitude(earthquakes, minMag, maxMag);
      }
      
      if (minDp !== undefined || maxDp !== undefined) {
        earthquakes = filterByDepth(earthquakes, minDp, maxDp);
      }
      
      if (loc) {
        earthquakes = filterByLocation(earthquakes, loc);
      }

      return c.json({
        meta: {
          timestamp: new Date().toISOString(),
          count: earthquakes.length,
          filters: {
            minMagnitude: minMag,
            maxMagnitude: maxMag,
            minDepth: minDp,
            maxDepth: maxDp,
            location: loc
          }
        },
        data: earthquakes
      });
    } catch (error) {
      console.error('Error filtering earthquakes:', error);
      return c.json(
        { 
          error: 'Failed to filter earthquakes',
          message: error instanceof Error ? error.message : 'Unknown error'
        },
        { status: 500 }
      );
    }
  }
);

app.get('/earthquakes/stats', async (c) => {
  try {
    const earthquakes = await fetchEarthquakes();
    
    const magnitudes = earthquakes.map(eq => eq.magnitudeNumeric);
    const depths = earthquakes.map(eq => eq.depth);
    
    const stats = {
      total_count: earthquakes.length,
      magnitude: {
        max: Math.max(...magnitudes),
        min: Math.min(...magnitudes),
        average: magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length
      },
      depth: {
        max: Math.max(...depths),
        min: Math.min(...depths),
        average: depths.reduce((a, b) => a + b, 0) / depths.length
      },
      most_recent: earthquakes[0],
      strongest: earthquakes.reduce((prev, curr) => 
        curr.magnitudeNumeric > prev.magnitudeNumeric ? curr : prev
      )
    };

    return c.json({
      meta: {
        timestamp: new Date().toISOString()
      },
      data: stats
    });
  } catch (error) {
    console.error('Error calculating stats:', error);
    return c.json(
      { 
        error: 'Failed to calculate earthquake statistics',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
});

// 404 handler
app.notFound((c) => {
  return c.json(
    { 
      error: 'Not Found',
      message: 'The requested endpoint does not exist',
      available_endpoints: [
        '/',
        '/earthquakes',
        '/earthquakes/top/:count',
        '/earthquakes/recent/:count',
        '/earthquakes/filter',
        '/earthquakes/stats',
        '/health'
      ]
    },
    { status: 404 }
  );
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json(
    {
      error: 'Internal Server Error',
      message: err.message
    },
    { status: 500 }
  );
});

export default app;
