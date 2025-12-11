# PHIVOCS API

A TypeScript-based API service for accessing PHIVOLCS (Philippine Institute of Volcanology and Seismology) earthquake data, built with Bun and Hono, which scrapes the data from the PHIVOLCS website.

## 🚀 Features

- TypeScript for type safety
- Request validation with Zod
- CORS support
- Response caching
- Error handling

## 🛠️ Prerequisites

- [Bun](https://bun.sh/) (v1.0.0 or later)
- Node.js (v18 or later, if not using Bun)

## 🚀 Getting Started

1. **Clone the repository**
   ```sh
   git clone https://github.com/yourusername/phivocs-api.git
   cd phivocs-api
   ```

2. **Install dependencies**
   ```sh
   bun install
   ```

3. **Run the development server**
   ```sh
   bun run dev
   ```

4. **API will be available at**
   ```
   http://localhost:3000
   ```

## 📦 Project Structure

```
phivocsAPI/
├── src/
│   └── index.ts      # Main application file with all routes and logic
├── .gitignore        # Git ignore file
├── bun.lockb         # Bun lockfile
├── package.json      # Project metadata and dependencies
├── README.md         # This file
└── tsconfig.json     # TypeScript configuration
```

## 🌐 API Endpoints

### `GET /health` - Health Check
Check the health status of the API and cache.

**Response**
```json
{
  "status": "healthy",
  "cache_valid": true,
  "last_update": "2023-12-11T15:30:00.000Z",
  "data_count": 50
}
```

### `GET /earthquakes` - Get All Earthquakes
Get all recent earthquakes with optional filtering.

**Query Parameters**
- `limit` (number, optional): Limit number of results (max: 100)
- `offset` (number, optional): Pagination offset

**Response**
```json
{
  "meta": {
    "timestamp": "2023-12-11T15:30:00.000Z",
    "count": 50,
    "cache_age_seconds": 120
  },
  "data": [
    {
      "date": "2023-12-11",
      "time": "14:30:00",
      "latitude": "10.50°N",
      "longitude": "125.20°E",
      "depth": "10 km",
      "magnitude": "4.5",
      "location": "15 km N 45° E of San Ricardo (Southern Leyte)",
      "magnitudeNumeric": 4.5
    }
  ]
}
```

### `GET /earthquakes/top/:count` - Get Top Earthquakes by Magnitude
Get the top N strongest earthquakes.

**Path Parameters**
- `count` (number, required): Number of top earthquakes to return (1-50)

**Response**
```json
{
  "meta": {
    "timestamp": "2023-12-11T15:30:00.000Z",
    "count": 5,
    "requested": 5,
    "total_available": 50
  },
  "data": [
    {
      "date": "2023-12-11",
      "time": "14:30:00",
      "magnitude": "5.8",
      "location": "15 km N 45° E of San Ricardo (Southern Leyte)",
      "magnitudeNumeric": 5.8
    }
  ]
}
```

### `GET /earthquakes/recent/:count` - Get Most Recent Earthquakes
Get the N most recent earthquakes.

**Path Parameters**
- `count` (number, required): Number of recent earthquakes to return (1-50)

**Response**
```json
{
  "meta": {
    "timestamp": "2023-12-11T15:30:00.000Z",
    "count": 5,
    "requested": 5
  },
  "data": [
    {
      "date": "2023-12-11",
      "time": "15:25:00",
      "magnitude": "4.2",
      "location": "10 km S of Batangas City",
      "magnitudeNumeric": 4.2
    }
  ]
}
```

### `GET /earthquakes/filter` - Filter Earthquakes
Filter earthquakes by various criteria.

**Query Parameters**
- `min_magnitude` (number, optional): Minimum magnitude
- `max_magnitude` (number, optional): Maximum magnitude
- `location` (string, optional): Location filter (case-insensitive partial match)

**Example Request**
```
GET /earthquakes/filter?min_magnitude=4.0&location=Batangas
```

**Response**
```json
{
  "meta": {
    "timestamp": "2023-12-11T15:30:00.000Z",
    "count": 3,
    "filters": {
      "min_magnitude": 4.0,
      "location": "Batangas"
    }
  },
  "data": [
    {
      "date": "2023-12-11",
      "time": "14:30:00",
      "magnitude": "4.2",
      "location": "10 km S of Batangas City",
      "magnitudeNumeric": 4.2
    }
  ]
}
```

### `GET /earthquakes/stats` - Get Earthquake Statistics
Get statistics about recent earthquakes.

**Response**
```json
{
  "meta": {
    "timestamp": "2023-12-11T15:30:00.000Z"
  },
  "data": {
    "total_count": 50,
    "magnitude": {
      "max": 5.8,
      "min": 2.1,
      "average": 3.4
    },
    "depth": {
      "max": 120,
      "min": 5,
      "average": 42.5
    },
    "most_recent": {
      "date": "2023-12-11",
      "time": "15:25:00",
      "magnitude": "4.2",
      "location": "10 km S of Batangas City",
      "magnitudeNumeric": 4.2
    },
    "strongest": {
      "date": "2023-12-11",
      "time": "14:30:00",
      "magnitude": "5.8",
      "location": "15 km N 45° E of San Ricardo (Southern Leyte)",
      "magnitudeNumeric": 5.8
    }
  }
}
```



## 🤝 Contributing

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [PHIVOLCS](https://www.phivolcs.dost.gov.ph/) - For the earthquake data
- [Bun](https://bun.sh/) - Fast JavaScript runtime
- [Hono](https://hono.dev/) - Ultrafast web framework
- [Zod](https://zod.dev/) - TypeScript-first schema validation
- [Cheerio](https://cheerio.js.org/) - HTML parsing and manipulation
