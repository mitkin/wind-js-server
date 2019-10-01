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

// cors config
var whitelist = [
	'http://localhost:63342',
	'http://localhost:3000',
	'http://localhost:4000' //,
	//'http://danwild.github.io'
];

var corsOptions = {
	origin: function(origin, callback){
		var originIsWhitelisted = whitelist.indexOf(origin) !== -1;
		callback(null, originIsWhitelisted);
	}
};

app.listen(port, function(err){
	console.log("running server on port "+ port);
});

app.get('/', cors(corsOptions), function(req, res){
    res.send('hello wind-js-server.. go to /latest for wind data..');
});

app.get('/alive', cors(corsOptions), function(req, res){
	res.send('wind-js-server is alive');
});

app.get('/latest', cors(corsOptions), function(req, res){

	/**
	 * Find and return the latest available 6 hourly pre-parsed JSON data
	 *
	 * @param targetMoment {Object} UTC moment
	 */
	function sendLatest(targetMoment){

		var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
		var fileName = __dirname +"/json-data/"+ stamp +".json";

		res.setHeader('Content-Type', 'application/json');
		res.sendFile(fileName, {}, function (err) {
			if (err) {
				console.log(stamp +' doesnt exist yet, trying previous interval..');
				sendLatest(moment(targetMoment).subtract(1, 'days'));
			}
		});
	}

	sendLatest(moment().utc());

});

app.get('/nearest', cors(corsOptions), function(req, res, next){

	var time = req.query.timeIso;
	var limit = req.query.searchLimit;
	var searchForwards = false;

	/**
	 * Find and return the nearest available 6 hourly pre-parsed JSON data
	 * If limit provided, searches backwards to limit, then forwards to limit before failing.
	 *
	 * @param targetMoment {Object} UTC moment
	 */
	function sendNearestTo(targetMoment){

		if( limit && Math.abs( moment.utc(time).diff(targetMoment, 'days'))  >= limit) {
			if(!searchForwards){
				searchForwards = true;
				sendNearestTo(moment(targetMoment).add(limit, 'days'));
				return;
			}
			else {
				return next(new Error('No data within searchLimit'));
			}
		}

		var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
		var fileName = __dirname +"/json-data/"+ stamp +".json";

		res.setHeader('Content-Type', 'application/json');
		res.sendFile(fileName, {}, function (err) {
			if(err) {
				var nextTarget = searchForwards ? moment(targetMoment).add(1, 'days') : moment(targetMoment).subtract(1, 'days');
				sendNearestTo(nextTarget);
			}
		});
	}

	if(time && moment(time).isValid()){
		sendNearestTo(moment.utc(time));
	}
	else {
		return next(new Error('Invalid params, expecting: timeIso=ISO_TIME_STRING'));
	}

});

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
		if (moment.utc().diff(targetMoment, 'days') > 30){
	        console.log('hit limit, harvest complete or there is a big gap in data..');
            return;
        }

		//var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);	//TODO
		var hourOffsetStr = (new Array(4).join('0') + hourOffset).substr(-3);
		var hourStamp = (new Array(4).join('0') + (hourOffset % 24).toString()).substr(-3);
		var dateStamp = formatDateStamp(targetMoment, hourOffset);
		//var stamp = moment(targetMoment).add(hourOffset, 'hours').format('YYYYMMDD') + hourStamp;	//TODO
		var stamp = dateStamp + hourStamp;
		var queryString = {
		    file: 'gfs.t'+ roundHours(moment(targetMoment).hour(), 6) +'z.pgrb2.1p00.f' + hourOffsetStr,	//TODO
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
				// don't rewrite stamps
				if(!checkPath('json-data/'+ stamp +'.json', false)) {

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
				else {
					console.log('already have '+ stamp +', not looking further');
					deferred.resolve({stamp: false, targetMoment: false});
				}
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

	child1 = exec('converter/bin/grib2json --data --output json-data/'+stamp+'.json --names --compact grib-data/'+stamp+'.f000',
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
				var nextStamp = nextDateStamp + nextHourOffsetStr;	//TODO

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

					console.log("attempting to harvest newer data "+ nextStamp);	//TODO
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
