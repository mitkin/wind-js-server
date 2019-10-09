var express = require("express");
var moment = require("moment");
var http = require('http');
var request = require('request');
var fs = require('fs');
var Q = require('q');
var cors = require('cors');

var app = express();
var port = process.env.PORT || 7000;
var baseDir ='http://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';

/**
 *
 * Returns the distance between two points on the map
 *
 * @param pointOne first point on map
 * @param pointTwo second point on map
 * @returns {Number} 
 */
function calcDistance(pointOne, pointTwo){
	var xDist = pointOne[1]-pointTwo[1]
	var yDist = pointOne[0]-pointTwo[0]
	return Math.sqrt(xDist*xDist + yDist*yDist);
}
  
/**
 *
 * Helper function for calcDistance when comparing two rainSpots
 *
 * @param pointOne first point on map
 * @param pointTwo second point on map
 * @returns {Number} 
 */
function _calcDistance(pointOne, arrayTwo){
	return arrayTwo.some(function(point) { return (calcDistance(pointOne, point) < 2) });
}
  
/**
 *
 * Returns rain spots on the map
 *
 * @param points precipitation data
 * @returns {Array} 
 */
function getRainSpots(points) {
	var tempSpots = [];
	t0 = performance.now();
	for (i = 0; i < points.length; i += 1) {
		if (tempSpots.length == 0) {
			tempSpots.push([points[i]]);
		} else {
			inner:
			for (j = tempSpots.length - 1; j >= 0; j -= 1) {
				if (tempSpots[j].some(function(x) { return (calcDistance(points[i], x) < 2); })) {
					if (tempSpots[j].some(function(x) { return (calcDistance(points[i], x) != 0); })) {
						tempSpots[j].push(points[i]);
						break inner;
					} else {
						console.error("Comparing the same point");
					}
				} else if (j == tempSpots.length - 1) {
					tempSpots.push([points[i]]);
				}
			}
		}
	}
	t1 = performance.now();
	console.log(t1-t0, "milliseconds");
	console.log("raintempSpots", tempSpots);
	console.log(tempSpots.length);
	var rainSpots = [];
	var currNumSpots = rainSpots.length;
	t0 = performance.now();
	for (i = 0; i < tempSpots.length; i++) {
		if (rainSpots.length == 0) {
			rainSpots.push(tempSpots[i]);
		} else {
			inner:
			for (j = 0; j < currNumSpots; j++) {
				if (tempSpots[i].some(function(x) { return (_calcDistance(x, rainSpots[j])); })) {
					rainSpots[j] = rainSpots[j].concat(tempSpots[i]);
					break inner;
				} else if (j == currNumSpots - 1) {
					rainSpots.push(tempSpots[i]);
				}
			}
		}
		currNumSpots = rainSpots.length;
	}
	t1 = performance.now();
	console.log(t1-t0, "milliseconds");
	console.log("rainSpots", rainSpots);
	console.log("rainSpots.length", rainSpots.length);
	return rainSpots;
}

/**
 *
 * Ping for new data every 15 mins
 *
 */
setInterval(function(){

	run(moment.utc(), 0);		// maybe change to malaysian time

}, 900000);

/**
 *
 * @param targetMoment {Object} moment to check for new data
 */
function run(targetMoment, hourOffset){
	getGribData(targetMoment, hourOffset).then(function(response){
		if(response.stamp){
			convertGribToJson(response.stamp, response.targetMoment, 
							  response.hourOffset, response.hourOffsetStr); 
		}
	});
}

/**
 *
 * Finds and returns the latest 6 hourly GRIB2 data from NOAAA
 *
 * @returns {*|promise}
 */
function getGribData(targetMoment, hourOffset){

	var deferred = Q.defer();

	function runQuery(targetMoment){
		// only go 2 weeks deep
		var newDate = moment(targetMoment.startOf('day'), "DD-MM-YYYY").add(hourOffset, 'hours');
		console.log("Day #", newDate.diff(targetMoment, 'days'))
		if (newDate.diff(targetMoment, 'days') > 15){
			console.log('hit limit, harvest complete or there is a big gap in data..');
			process.exit(0);
            return;
        }

		//var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);	
		var hourOffsetStr = (new Array(4).join('0') + hourOffset).substr(-3);
		var hourStamp = (new Array(4).join('0') + (hourOffset % 24).toString()).substr(-3);
		var dateStamp = formatDateStamp(targetMoment, hourOffset);
		//var stamp = moment(targetMoment).add(hourOffset, 'hours').format('YYYYMMDD') + hourStamp;	
		var stamp = dateStamp + hourStamp;
		var queryString = {
		    file: 'gfs.t'+ roundHours(moment(targetMoment).hour(), 6) +'z.pgrb2.1p00.f' + hourOffsetStr,	
		    lev_10_m_above_ground: 'on',
		    lev_surface: 'on',
		    var_TMP: 'on',
		    var_UGRD: 'on',
			var_VGRD: 'on',
			var_PRATE: 'on',
		    leftlon: 0,
		    rightlon: 360,
		    toplat: 90,
		    bottomlat: -90,
		    dir: '/gfs.' + moment(targetMoment).format('YYYYMMDD') + '/' + roundHours(moment(targetMoment).hour(), 6)	//TODO
		};
		const qsConstructor = qs => {
		    let str = '';

		    for (let i in qs) {
		        str += `${i}=${qs[i]}&`;
		    }

		    return str;
        };

		console.log('GET', baseDir + '?' + qsConstructor(queryString));
		request.get({
			url: baseDir,
			qs: queryString
		}).on('error', function(err){
			// console.log(err);
			runQuery(moment(targetMoment).subtract(1, 'days'));	//TODO

		}).on('response', function(response) {

			console.log('response '+response.statusCode + ' | '+stamp);

			if(response.statusCode != 200){
				runQuery(moment(targetMoment).subtract(1, 'days'));
			}

			else {
				console.log('piping ' + stamp);

				// mk sure we've got somewhere to put output
				checkPath('grib-data', true);

				// pipe the file, resolve the valid time stamp
				var file = fs.createWriteStream("grib-data/"+stamp+".f000");
				response.pipe(file);
				file.on('finish', function() {
					file.close();
					deferred.resolve({stamp: stamp, targetMoment: targetMoment, 
									hourOffset: hourOffset, hourOffsetStr}); 
				});
			}
		});

	}

	runQuery(targetMoment);
	return deferred.promise;
}

function convertGribToJson(stamp, targetMoment, hourOffset, hourOffsetStr){

	// mk sure we've got somewhere to put output
	checkPath('json-data', true);
	checkPath('temperature-data', true);
	checkPath('precipitation-data', true);

	var exec = require('child_process').exec, child;

	child = exec('converter/bin/grib2json --data --output json-data/'+stamp+'.json --names --compact grib-data/'+stamp+'.f000',
		{maxBuffer: 500*1024},
		function (error, stdout, stderr){

			if(error){
				console.log('exec error: ' + error);
			}

			else {
				console.log("converted :)");

				// don't keep raw grib data
				exec('rm grib-data/*');

				// if we don't have newer stamp, try and harvest one 
				var nextHourOffset = hourOffset + 3;
				var nextHourOffsetStr = (new Array(4).join('0') + (nextHourOffset % 24)).substr(-3);
				var nextDateStamp = formatDateStamp(targetMoment, nextHourOffset);
				var nextStamp = nextDateStamp + nextHourOffsetStr;	

				if(!checkPath('json-data/'+ nextStamp +'.json', false)){

					// extract temperature data
					exec('python3 getTemp.py '+'json-data/'+stamp+'.json '+'temperature-data/'+stamp+'.json',
					{maxBuffer: 500*1024},
					function (error, stdout, stderr){

						if(error){
							console.log('exec error: ' + error);
						} 
					});

					// extract precipitation data
					exec('python3 getPrecipitation.py '+'json-data/'+stamp+'.json '+'precipitation-data/'+stamp+'.json',
					{maxBuffer: 500*1024},
					function (error, stdout, stderr){

						if(error){
							console.log('exec error: ' + error);
						} 
					});

					console.log("attempting to harvest newer data "+ nextStamp);	
					run(targetMoment, nextHourOffset);
				}

				else {
					console.log('got newer, still going to harvest next data '+ nextStamp);
					run(targetMoment, nextHourOffset);
				}
			}
		});
}

/**
 *
 * Round hours to expected interval, e.g. we're currently using 6 hourly interval
 * i.e. 00 || 06 || 12 || 18
 *
 * @param hours
 * @param interval
 * @returns {String}
 */
function roundHours(hours, interval){
	if(interval > 0){
		var result = (Math.floor(hours / interval) * interval);
		return result < 10 ? '0' + result.toString() : result;
	}
}

/**
 * Sync check if path or file exists
 *
 * @param path {string}
 * @param mkdir {boolean} create dir if doesn't exist
 * @returns {boolean}
 */
function checkPath(path, mkdir) {
    try {
	    fs.statSync(path);
	    return true;

    } catch(e) {
        if(mkdir){
	        fs.mkdirSync(path);
        }
	    return false;
    }
}

/**
 *
 * Format the date correctly based on the hour offset
 * 
 * @param targetMoment {Object} moment to check for new data
 * @param hourOffset {Int} offset from target moment (forward)
 * @returns {Object moment} 
 */
function formatDateStamp(targetMoment, hourOffset) {
	var dayOffset = parseInt(hourOffset / 24);
	return moment(targetMoment).add(dayOffset, 'days').format('YYYYMMDD');
}

// init harvest
run(moment.utc(), 0);	// maybe change to malaysian time
