
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Add your Mapbox public access token here
mapboxgl.accessToken = 'pk.eyJ1IjoibHp1YmlhdGUiLCJhIjoiY213ZmZ4cm1jMDBvaTJ6b3I4bDhuN2o4NiJ9.0nnVqFWOdYXQMLIDrlmBoA';

// Initialize map
const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [-71.09415, 42.36027],
    zoom: 12,
    minZoom: 5,
    maxZoom: 18
});

map.addControl(new mapboxgl.NavigationControl());

// Data URLs
const STATIONS_URL =
    'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';

const TRIPS_URL =
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';

const BOSTON_BIKES_URL =
    'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson';

// Cambridge official bike facilities GeoJSON
const CAMBRIDGE_BIKES_URL =
    'https://services1.arcgis.com/WnzC35krSYGuYov4/ArcGIS/rest/services/Bike_Facilities/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson';

// Time-based buckets for performance
let departuresByMinute = Array.from(
    { length: 1440 },
    () => []
);

let arrivalsByMinute = Array.from(
    { length: 1440 },
    () => []
);


// Helper: get station ID
function stationId(station) {
    return String(
        station.short_name ??
        station.Number ??
        station.number ??
        station.station_id ??
        station.id
    );
}


// Helper: convert station coordinates
function getCoords(station) {
    const longitude = Number(station.lon ?? station.Long);
    const latitude = Number(station.lat ?? station.Lat);

    const point = new mapboxgl.LngLat(
        longitude,
        latitude
    );

    const { x, y } = map.project(point);

    return {
        cx: x,
        cy: y
    };
}


// Helper: minutes since midnight
function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
}


// Efficient time filtering
function filterByMinute(tripsByMinute, minute) {

    if (minute === -1) {
        return tripsByMinute.flat();
    }

    const minMinute = (minute - 60 + 1440) % 1440;
    const maxMinute = (minute + 60) % 1440;

    if (minMinute > maxMinute) {

        const beforeMidnight =
            tripsByMinute.slice(minMinute);

        const afterMidnight =
            tripsByMinute.slice(0, maxMinute + 1);

        return beforeMidnight.concat(afterMidnight).flat();

    } else {

        return tripsByMinute
            .slice(minMinute, maxMinute + 1)
            .flat();
    }
}


// Calculate arrivals and departures
function computeStationTraffic(stations, timeFilter = -1) {

    const departures = d3.rollup(
        filterByMinute(departuresByMinute, timeFilter),
        (v) => v.length,
        (d) => String(d.start_station_id)
    );

    const arrivals = d3.rollup(
        filterByMinute(arrivalsByMinute, timeFilter),
        (v) => v.length,
        (d) => String(d.end_station_id)
    );

    return stations.map((station) => {

        const id = stationId(station);

        const stationDepartures = departures.get(id) ?? 0;
        const stationArrivals = arrivals.get(id) ?? 0;

        return {
            ...station,
            departures: stationDepartures,
            arrivals: stationArrivals,
            totalTraffic: stationDepartures + stationArrivals
        };
    });
}


// Format minutes into a readable time
function formatTime(minutes) {
    const date = new Date(2000, 0, 1, 0, minutes);

    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit'
    });
}


// Wait until the map is ready
map.on('load', async () => {

    try {

        // Add Boston bike lanes
        map.addSource('boston-bike-lanes', {
            type: 'geojson',
            data: BOSTON_BIKES_URL
        });

        map.addLayer({
            id: 'boston-bike-lanes',
            type: 'line',
            source: 'boston-bike-lanes',
            paint: {
                'line-color': '#32D400',
                'line-width': 3,
                'line-opacity': 0.5
            }
        });


        // Add Cambridge bike lanes
        map.addSource('cambridge-bike-lanes', {
            type: 'geojson',
            data: CAMBRIDGE_BIKES_URL
        });

        map.addLayer({
            id: 'cambridge-bike-lanes',
            type: 'line',
            source: 'cambridge-bike-lanes',
            paint: {
                'line-color': '#32D400',
                'line-width': 3,
                'line-opacity': 0.5
            }
        });


        // Load station and traffic data
        const [stationData, trips] = await Promise.all([

            d3.json(STATIONS_URL),

            d3.csv(TRIPS_URL, (trip) => {

                trip.started_at = new Date(
                    trip.started_at.replace(' ', 'T')
                );

                trip.ended_at = new Date(
                    trip.ended_at.replace(' ', 'T')
                );

                return trip;
            })
        ]);


        // Access station array
        const stations =
            stationData.data?.stations ??
            stationData.stations ??
            [];

        console.log('Loaded stations:', stations.length);
        console.log('Loaded trips:', trips.length);


        // Create departure and arrival buckets
        for (const trip of trips) {

            const startedMinute =
                minutesSinceMidnight(trip.started_at);

            const endedMinute =
                minutesSinceMidnight(trip.ended_at);

            departuresByMinute[startedMinute].push(trip);
            arrivalsByMinute[endedMinute].push(trip);
        }


        // Create SVG overlay
        const svg = d3.select('#map').select('svg');


        // Initial station traffic
        const initialStations =
            computeStationTraffic(stations);


        // Radius scale
        const radiusScale = d3.scaleSqrt()
            .domain([
                0,
                d3.max(initialStations, (d) => d.totalTraffic) || 1
            ])
            .range([0, 25]);


        // Color scale for traffic direction
        const stationFlow = d3.scaleQuantize()
            .domain([0, 1])
            .range([0, 0.5, 1]);


        // Create station circles
        let circles = svg
            .selectAll('circle')
            .data(initialStations, (d) => stationId(d))
            .enter()
            .append('circle')
            .attr('r', (d) => radiusScale(d.totalTraffic))
            .attr('stroke', 'white')
            .attr('stroke-width', 1)
            .style('fill-opacity', 0.6)
            .style('--departure-ratio', (d) =>
                d.totalTraffic > 0
                    ? stationFlow(d.departures / d.totalTraffic)
                    : 0.5
            );


        // Add exact traffic information
        function updateCircleTitles() {

            circles.selectAll('title')
                .data((d) => [d])
                .join('title')
                .text((d) =>
                    `${d.totalTraffic} trips
                    (${d.departures} departures,
                    ${d.arrivals} arrivals)`
                );
        }

        updateCircleTitles();


        // Update circle positions
        function updatePositions() {

            circles
                .attr('cx', (d) => getCoords(d).cx)
                .attr('cy', (d) => getCoords(d).cy);
        }

        updatePositions();

        // Update when map moves or zooms
        map.on('move', updatePositions);
        map.on('zoom', updatePositions);
        map.on('resize', updatePositions);
        map.on('moveend', updatePositions);


        // Update traffic according to selected time
        function updateScatterPlot(timeFilter) {

            const filteredStations =
                computeStationTraffic(stations, timeFilter);

            // Adjust circle sizes
            const maxTraffic =
                d3.max(filteredStations, (d) => d.totalTraffic) || 1;

            radiusScale.domain([0, maxTraffic]);

            if (timeFilter === -1) {
                radiusScale.range([0, 25]);
            } else {
                radiusScale.range([3, 50]);
            }

            // Update circles with station IDs as keys
            circles = svg
                .selectAll('circle')
                .data(
                    filteredStations,
                    (d) => stationId(d)
                )
                .join('circle')
                .attr('cx', (d) => getCoords(d).cx)
                .attr('cy', (d) => getCoords(d).cy)
                .attr('r', (d) =>
                    radiusScale(d.totalTraffic)
                )
                .attr('stroke', 'white')
                .attr('stroke-width', 1)
                .style('fill-opacity', 0.6)
                .style('--departure-ratio', (d) =>
                    d.totalTraffic > 0
                        ? stationFlow(
                            d.departures / d.totalTraffic
                        )
                        : 0.5
                );

            updateCircleTitles();
        }


        // Time slider
        const timeSlider =
            document.getElementById('time-slider');

        const selectedTime =
            document.getElementById('selected-time');

        const anyTimeLabel =
            document.getElementById('any-time');


        let timeFilter = -1;


        // Update the time display and map
        function updateTimeDisplay() {

            timeFilter = Number(timeSlider.value);

            if (timeFilter === -1) {

                selectedTime.textContent = '';
                anyTimeLabel.style.display = 'block';

            } else {

                selectedTime.textContent =
                    formatTime(timeFilter);

                anyTimeLabel.style.display = 'none';
            }

            updateScatterPlot(timeFilter);
        }


        // Listen for slider changes
        timeSlider.addEventListener(
            'input',
            updateTimeDisplay
        );

        // Initial update
        updateTimeDisplay();


    } catch (error) {

        console.error('Error loading map data:', error);

        document.getElementById('map').insertAdjacentHTML(
            'beforeend',
            '<p class="map-error">Unable to load the map data. Check the browser console.</p>'
        );
    }
});
