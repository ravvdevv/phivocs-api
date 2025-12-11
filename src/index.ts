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
  depth: z.string(),
  magnitude: z.string(),
  location: z.string(),
  magnitudeNumeric: z.number()
});

type EarthquakeData = z.infer<typeof EarthquakeSchema>;

interface CacheEntry {
  data: EarthquakeData[];
  timestamp: number;
}

// =============================================
// Constants
// =============================================
const PHIVOLCS_URL = 'https://earthquake.phivolcs.dost.gov.ph/';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOP_COUNT = 50;
const REQUEST_TIMEOUT = 15000;

// =============================================
// In-Memory Cache
// =============================================
let earthquakeCache: CacheEntry | null = null;

// =============================================
// Helper Functions
// =============================================
function parseMagnitude(mag: string): number {
  const parsed = parseFloat(mag);
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
        'User-Agent': 'PHIVOLCS-API-Client/1.0'
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

      const earthquake = {
        date: date.trim(),
        time: time.trim(),
        latitude: $cols.eq(1).text().trim(),
        longitude: $cols.eq(2).text().trim(),
        depth: $cols.eq(3).text().trim(),
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

function filterByMagnitude(earthquakes: EarthquakeData[], minMag: number, maxMag?: number): EarthquakeData[] {
  return earthquakes.filter(eq => {
    const mag = eq.magnitudeNumeric;
    return mag >= minMag && (!maxMag || mag <= maxMag);
  });
}

function filterByLocation(earthquakes: EarthquakeData[], location: string): EarthquakeData[] {
  const searchTerm = location.toLowerCase();
  return earthquakes.filter(eq => 
    eq.location.toLowerCase().includes(searchTerm)
  );
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

// =============================================
// Routes
// =============================================
app.get('/', (c) => {
  return c.json({
    name: 'PHIVOLCS Earthquake API',
    version: '2.0.0',
    description: 'RESTful API for Philippine earthquake data from PHIVOLCS',
    endpoints: {
      '/': 'API documentation',
      '/earthquakes': 'Get all recent earthquakes',
      '/earthquakes/top/:count': 'Get top N earthquakes by magnitude',
      '/earthquakes/recent/:count': 'Get N most recent earthquakes',
      '/earthquakes/filter': 'Filter earthquakes by magnitude or location',
      '/earthquakes/stats': 'Get earthquake statistics',
      '/health': 'API health check'
    },
    cache_ttl: `${CACHE_TTL_MS / 1000}s`,
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

app.get('/earthquakes', async (c) => {
  try {
    const earthquakes = await fetchEarthquakes();
    
    return c.json({
      meta: {
        timestamp: new Date().toISOString(),
        count: earthquakes.length,
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
});

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

app.get(
  '/earthquakes/filter',
  zValidator(
    'query',
    z.object({
      min_magnitude: z.string().optional().transform(val => val ? parseFloat(val) : undefined),
      max_magnitude: z.string().optional().transform(val => val ? parseFloat(val) : undefined),
      location: z.string().optional()
    })
  ),
  async (c) => {
    const { min_magnitude, max_magnitude, location } = c.req.valid('query');
    
    try {
      let earthquakes = await fetchEarthquakes();
      
      if (min_magnitude !== undefined) {
        earthquakes = filterByMagnitude(earthquakes, min_magnitude, max_magnitude);
      }
      
      if (location) {
        earthquakes = filterByLocation(earthquakes, location);
      }

      return c.json({
        meta: {
          timestamp: new Date().toISOString(),
          count: earthquakes.length,
          filters: {
            min_magnitude,
            max_magnitude,
            location
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
    const depths = earthquakes.map(eq => parseMagnitude(eq.depth));
    
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