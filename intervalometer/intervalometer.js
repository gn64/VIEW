var EventEmitter = require("events").EventEmitter;
var exec = require('child_process').exec;
require('rootpath')();
var camera = require('camera/camera.js');
var db = require('system/db.js');
var mcu = require('hardware/mcu.js');
var nmx = require('drivers/nmx.js');
var image = require('camera/image/image.js');
var power = require('hardware/power.js');
var exp = require('intervalometer/exposure.js');
var interpolate = require('intervalometer/interpolate.js');
var fs = require('fs');
var async = require('async');
var TLROOT = "/root/time-lapse";
var Button = require('gpio-button');
var gpio = require('linux-gpio');
var _ = require('underscore');

var AUXTIP_OUT = 111;
var AUXRING_OUT = 110;
var HOTSHOE_IN = 34;

gpio.setMode(gpio.MODE_RAW);

gpio.setup(AUXTIP_OUT, gpio.DIR_OUT, function(err){
    if(err) console.log("GPIO error: ", err);
    gpio.write(AUXTIP_OUT, 1);
});

gpio.setup(AUXRING_OUT, gpio.DIR_OUT, function(err){
    if(err) console.log("GPIO error: ", err);
    gpio.write(AUXRING_OUT, 1);
});

gpio.setup(HOTSHOE_IN, gpio.DIR_IN, function(err){
    if(err) console.log("GPIO error: ", err);
});

var intervalometer = new EventEmitter();

var timerHandle = null;
var delayHandle = null;

defaultProgram = {
    rampMode: "fixed",
    intervalMode: "fixed",
    interval: 5,
    dayInterval: 5,
    nightInterval: 35,
    frames: 300,
    destination: 'camera',
    nightCompensation: -1,
    isoMax: -6,
    isoMin:  0,
    rampParameters:  'S+I',
    apertureMax: -2,
    apertureMin:  -4,
    manualAperture: -5,
    keyframes: [{
        focus: 0,
        ev: "not set",
        motor: {}
    }]
};

var rate = 0;
var status = {
    running: false,
    frames: 0,
    framesRemaining: 0,
    rampRate: 0,
    intervalMs: 0,
    message: "",
    rampEv: null
}

intervalometer.autoSettings = {
    paddingTimeMs: 5000
}

var nmx = null;
var db = null;
var mcu = null;

intervalometer.timelapseFolder = false;

intervalometer.status = status;

intervalometer.load = function(program) {
    if(!program.frames) program.frames = Infinity; // Infinity comes back as null from the DB
    intervalometer.currentProgram = _.extendOwn(defaultProgram, intervalometer.currentProgram, program);
}
intervalometer.load(defaultProgram);

var auxTrigger = new Button('input-aux2');

auxTrigger.on('press', function() {
    console.log("AUX2 trigger!");
    if (status.running && intervalometer.currentProgram.intervalMode == 'aux') timerHandle = setTimeout(runPhoto, 0);
});

auxTrigger.on('error', function(err) {
    console.log("AUX2 error: ", err);
});

function motionSyncPulse() {
    if (status.running && intervalometer.currentProgram.intervalMode != 'aux') {
        gpio.read(HOTSHOE_IN, function(err, shutterClosed) {
            console.log("hotshoe:", shutterClosed);
            if(shutterClosed) {
                console.log("=> AUX Pulse");
                gpio.write(AUXTIP_OUT, 0, function() {
                    setTimeout(function(){
                        gpio.write(AUXTIP_OUT, 1);
                    }, 200);
                });
            } else {
                setTimeout(motionSyncPulse, 100);
            }
        });

    } 
}

function fileInit() {
    fs.writeFileSync(status.timelapseFolder + "/details.csv", "frame, error, target, setting, rate, interval, timestamp, file, p, i, d\n");
}

function writeFile() {
    fs.appendFileSync(status.timelapseFolder + "/details.csv", status.frames + ", " + status.evDiff + "," + exp.status.targetEv + "," + status.rampEv + "," + exp.status.rate + "," + (status.intervalMs / 1000) + "," + status.lastPhotoTime + "," + status.path + "," + exp.status.pComponent + "," + exp.status.iComponent + "," + exp.status.dComponent + "\n");
    //image.writeXMP(name, status.evDiff);
}

function getDetails(file) {
    var d = {
        frames: status.frames,
        evCorrection: status.evDiff,
        targetEv: exp.status.targetEv,
        actualEv: status.rampEv,
        rampRate: exp.status.rate,
        intervalMs: status.intervalMs,
        timestamp: status.lastPhotoTime,
        fileName: file || status.path,
        p: exp.status.pComponent,
        i: exp.status.iComponent,
        d: exp.status.dComponent,
    };
    if(mcu && mcu.lastGpsFix) {
        d.latitude = mcu.lastGpsFix.lat;
        d.longitude = mcu.lastGpsFix.lon;
    }
    return d;
}

var startShutterEv = -1;

function calculateIntervalMs(interval, currentEv) {
    var dayEv = 8;
    var nightEv = -2;
    if (intervalometer.currentProgram.intervalMode == 'fixed') {
        //console.log("using fixed interval: ", interval);
        return interval * 1000;
    } else {
        /*if (status.frames == 0) {
            startShutterEv = shutterEv;
            if (startShutterEv < -5) startShutterEv = -5;
        }
        var thirtySecondEv = -11;
        var newInterval = interpolate.linear([{
            x: startShutterEv,
            y: parseInt(intervalometer.currentProgram.dayInterval)
        }, {
            x: thirtySecondEv,
            y: parseInt(intervalometer.currentProgram.nightInterval)
        }], shutterEv);*/

        var newInterval = interpolate.linear([{
            x: dayEv,
            y: parseInt(intervalometer.currentProgram.dayInterval)
        }, {
            x: nightEv,
            y: parseInt(intervalometer.currentProgram.nightInterval)
        }], currentEv);
        return newInterval * 1000;
    }
}

function doKeyframeAxis(axisName, axisSubIndex, setupFirst, motionFunction) {
    var keyframes = intervalometer.currentProgram.keyframes;
    if (status.running && keyframes && keyframes.length > 0 && keyframes[0][axisName] != null) {
        var kfSet = null;
        var kfCurrent = null;

        if (setupFirst) {
            keyframes[0].seconds = 0;
            if(axisSubIndex != null) {
                keyframes[0][axisName][axisSubIndex] = 0;
            } else {
                keyframes[0][axisName] = 0;
            }
            kfSet = 0;
        } else {
            var secondsSinceStart = status.lastPhotoTime + (status.intervalMs / 1000);

            console.log("KF: Seconds since start: " + secondsSinceStart);
            kfPoints = keyframes.map(function(kf) {
                if(axisSubIndex != null) {
                    return {
                        x: kf.seconds,
                        y: kf[axisName][axisSubIndex] || 0
                    }
                } else {
                    return {
                        x: kf.seconds,
                        y: kf[axisName] || 0
                    }
                }
            });
            kfSet = interpolate.linear(kfPoints, secondsSinceStart);
            console.log("FK: " + axisName + " target: " + kfSet);
        }
        var axisNameExtension = '';
        if(axisSubIndex != null) axisNameExtension = '-' + axisSubIndex;
        kfCurrent = intervalometer.currentProgram[axisName + axisNameExtension + 'Pos'];

        if (kfCurrent == null) {
            motionFunction(kfSet); // absolute setting (like ev)
        } else {
            var kfTarget = Math.round(kfSet);
            if (kfTarget != intervalometer.currentProgram[axisName + axisNameExtension + 'Pos']) {
                var relativeMove = kfTarget - intervalometer.currentProgram[axisName + axisNameExtension + 'Pos'];
                motionFunction(relativeMove);
                intervalometer.currentProgram[axisName + axisNameExtension + 'Pos'] = kfTarget;
            } else {
                if (motionFunction) motionFunction();
            }
        }

    } else {
        if (motionFunction) motionFunction();
    }
}

function processKeyframes(setupFirst, callback) {

    var numAxes = 2;
    var axesDone = 0;

    if(intervalometer.currentProgram.keyframes && intervalometer.currentProgram.keyframes.length > 0 && intervalometer.currentProgram.keyframes[0].motor) {
        for(motorId in intervalometer.currentProgram.keyframes[0].motor) numAxes++;
    }

    var checkDone = function() {
        axesDone++;
        console.log("KF: " + axesDone + " keyframe items complete");
        if (axesDone >= numAxes && callback) {
            console.log("KF: keyframes complete, running callback");
            callback();
        }
    }

    doKeyframeAxis('ev', null, setupFirst, function(ev) {
        //if (ev != null && camera.settings.ev != ev) camera.setEv(ev);
        checkDone();
    });

    doKeyframeAxis('focus', null, setupFirst, function(focus) {
        if (focus) {
            camera.ptp.preview(function() {
                setTimeout(function() {
                    console.log("KF: Moving focus by " + focus + " steps");
                    var dir = focus > 0 ? 1 : -1;
                    var steps = Math.abs(focus);
                    camera.ptp.focus(dir, steps, function() {
                        checkDone();
                    });
                }, 500);
            });
        } else {
            checkDone();
        }
    });

    if(intervalometer.currentProgram.keyframes && intervalometer.currentProgram.keyframes.length > 0 && intervalometer.currentProgram.keyframes[0].motor) for(motorId in intervalometer.currentProgram.keyframes[0].motor) {
        doKeyframeAxis('motor', motorId, setupFirst, function(move) {
            var parts = motorId.split('-');
            if (move && parts.length == 2) {
                var driver = parts[0];
                var motor = parts[1];
                console.log("KF: Moving " + motorId + " by " + move + " steps");
                if(driver == 'NMX') {
                    if (nmx && nmx.getStatus().connected) {
                        nmx.move(motor, 0 - move, function() {
                            checkDone();
                        });
                    } else {
                        console.log("KF: error moving -- nmx not connected");
                        checkDone();
                    }
                } else {
                    checkDone();
                }
            } else {
                checkDone();
            }
        });
    }

}

function getEvOptions() {
    var maxShutterLengthMs = status.intervalMs;
    if (maxShutterLengthMs > intervalometer.autoSettings.paddingTimeMs) maxShutterLengthMs = (status.intervalMs - intervalometer.autoSettings.paddingTimeMs);
    return {
        settingsDetails: camera.ptp.settings.details,
        maxShutterLengthMs: maxShutterLengthMs,
        isoMax: intervalometer.currentProgram.isoMax,
        isoMin: intervalometer.currentProgram.isoMin,
        shutterMax: intervalometer.currentProgram.shutterMax,
        apertureMax: intervalometer.currentProgram.apertureMax,
        apertureMin: intervalometer.currentProgram.apertureMin,
        parameters: intervalometer.currentProgram.rampParameters || 'S+I',
        blendParams: intervalometer.currentProgram.rampParameters && intervalometer.currentProgram.rampParameters.indexOf('=') !== -1
    }
}

var busyExposure = false;

function setupExposure(cb) {
    var expSetupStartTime = new Date() / 1000;
    console.log("\n\nEXP: setupExposure");
    busyExposure = true;
    camera.getEv(function(err, currentEv, params) {
        console.log("EXP: current interval: ", status.intervalMs, " (took ", (new Date() / 1000 - expSetupStartTime), "seconds from setup start");
        console.log("EXP: current ev: ", currentEv);
        camera.setEv(status.rampEv, getEvOptions(), function(err, res) {
            status.evDiff = res.ev - status.rampEv;
            console.log("EXP: program:", "capture", " (took ", (new Date() / 1000 - expSetupStartTime), "seconds from setup start");
            status.lastPhotoTime = new Date() / 1000 - status.startTime;
            busyExposure = false;
            cb && cb(err);
        });
    });
}

var busyPhoto = false;

function runPhoto() {
    if(!status.running) {
        busyPhoto = false;
        status.stopping = false;
        return;
    }
    if ((busyPhoto || busyExposure) && intervalometer.currentProgram.rampMode == "auto") {
        if (status.running) setTimeout(runPhoto, 100);
        return;
    }
    if(!status.running) return;
    busyPhoto = true;
    if (camera.ptp.connected) {
        status.captureStartTime = new Date() / 1000;
        intervalometer.emit("status", status);
        var captureOptions = {
            thumbnail: true,
            index: status.frames
                //saveTiff: "/mnt/sd/test" + status.frames + ".tiff",
                //saveRaw: "/mnt/sd/test" + status.frames + ".cr2",
        }
        if (intervalometer.currentProgram.destination == 'sd' && camera.ptp.sdPresent && camera.ptp.sdMounted) {
            console.log("CAPT: Saving timelapse to SD card");
            captureOptions.thumbnail = false;
            var framesPadded = status.frames.toString();
            while (framesPadded.length < 4) framesPadded = '0' + framesPadded;
            captureOptions.saveRaw = status.mediaFolder + "/img-" + framesPadded;
            camera.ptp.saveToCameraCard(false);
        } else {
            camera.ptp.saveToCameraCard(true);
        }

        if (intervalometer.currentProgram.rampMode == "fixed") {
            status.intervalMs = intervalometer.currentProgram.interval * 1000;
            if (status.running) timerHandle = setTimeout(runPhoto, status.intervalMs);
            status.lastPhotoTime = new Date() / 1000 - status.startTime;
            setTimeout(motionSyncPulse, camera.lists.getSecondsFromEv(camera.ptp.settings.details.shutter.ev) * 1000 + 1500);
            captureOptions.calculateEv = false;
            camera.ptp.capture(captureOptions, function(err, photoRes) {
                if (!err && photoRes) {
                    status.path = photoRes.file;
                    if(photoRes.cameraCount > 1) {
                        for(var i = 0; i < photoRes.cameraResults.length; i++) {
                            console.log("photoRes.cameraResults[" + i + "]:");
                            console.log(photoRes.cameraResults[i]);
                            db.setTimelapseFrame(status.id, 0, getDetails(photoRes.cameraResults[i].file), photoRes.cameraResults[i].cameraIndex, photoRes.cameraResults[i].thumbnailPath);
                        }
                    } else {
                        db.setTimelapseFrame(status.id, 0, getDetails(), 1, photoRes.thumbnailPath);
                    }
                    status.message = "running";
                    if (status.framesRemaining > 0) status.framesRemaining--;
                    status.frames++;
                    //writeFile();
                    intervalometer.emit("status", status);
                    console.log("TL: program status:", status);
                } else {
                    intervalometer.emit('error', "An error occurred during capture.  This could mean that the camera body is not supported or possibly an issue with the cable disconnecting.\nThe time-lapse will attempt to continue anyway.\nSystem message: ", err);
                }
                if (status.framesRemaining < 1 || status.running == false || status.stopping == true) {
                    clearTimeout(timerHandle);
                    status.message = "done";
                    status.framesRemaining = 0;
                    intervalometer.cancel('done');
                }
                processKeyframes(false, function() {
                    busyPhoto = false;
                });
            });
        } else {
            if (status.rampEv === null) status.rampEv = camera.getEvFromSettings(camera.ptp.settings);
            captureOptions.exposureCompensation = status.evDiff || 0;
            captureOptions.calculateEv = true;

            if(intervalometer.currentProgram.intervalMode == 'aux') {
                if(status.intervalStartTime) status.intervalMs = ((new Date() / 1000) - status.intervalStartTime) * 1000;
                status.intervalStartTime = new Date() / 1000;
            } else {
                status.intervalMs = calculateIntervalMs(intervalometer.currentProgram.interval, status.rampEv);
                console.log("TL: Setting timer for fixed interval at ", status.intervalMs);
                if (status.running) timerHandle = setTimeout(runPhoto, status.intervalMs);
            } 

            intervalometer.emit("status", status);
            var shutterEv;
            if(camera.ptp.settings.details.shutter) shutterEv = camera.ptp.settings.details.shutter.ev; else shutterEv = 0;
            var msDelayPulse = camera.lists.getSecondsFromEv(shutterEv) * 1000 + 1500;
            setTimeout(motionSyncPulse, msDelayPulse);
            camera.ptp.capture(captureOptions, function(err, photoRes) {
                if (!err && photoRes) {
                    var bufferTime = (new Date() / 1000) - status.captureStartTime - camera.lists.getSecondsFromEv(camera.ptp.settings.details.shutter.ev);
                    if(!status.bufferSeconds) {
                        status.bufferSeconds = bufferTime;
                    } else if(bufferTime > status.bufferSeconds) {
                        status.bufferSeconds = (status.bufferSeconds + bufferTime) / 2;
                    }
                    status.path = photoRes.file;
                    if(photoRes.cameraCount > 1) {
                        for(var i = 0; i < photoRes.cameraResults.length; i++) {
                            db.setTimelapseFrame(status.id, status.evDiff, getDetails(photoRes.cameraResults[i].file), photoRes.cameraResults[i].cameraIndex, photoRes.cameraResults[i].thumbnailPath);
                        }
                    } else {
                        db.setTimelapseFrame(status.id, status.evDiff, getDetails(), 1, photoRes.thumbnailPath);
                    }
                    intervalometer.autoSettings.paddingTimeMs = status.bufferSeconds * 1000 + 1000; // add a second for setting exposure
                    status.rampEv = exp.calculate(status.rampEv, photoRes.ev, camera.minEv(camera.ptp.settings, getEvOptions()), camera.maxEv(camera.ptp.settings, getEvOptions()));
                    status.rampRate = exp.status.rate;
                    status.path = photoRes.file;
                    status.message = "running";
                    if(intervalometer.currentProgram.intervalMode == 'aux') status.message = "waiting for AUX2...";
                    setupExposure();
                    if (status.framesRemaining > 0) status.framesRemaining--;
                    status.frames++;
                    writeFile();
                    intervalometer.emit("status", status);
                    console.log("TL: program status:", status);
                } else {
                    if(!err) err = "unknown";
                    intervalometer.emit('error', "An error occurred during capture.  This could mean that the camera body is not supported or possibly an issue with the cable disconnecting.\nThe time-lapse will attempt to continue anyway.\nSystem message: " + err);
                    console.log("TL: error:", err);
                }
                if ((intervalometer.currentProgram.intervalMode == "fixed" && status.framesRemaining < 1) || status.running == false || status.stopping == true) {
                    clearTimeout(timerHandle);
                    status.stopping = false;
                    status.message = "done";
                    status.framesRemaining = 0;
                    intervalometer.cancel('done');
                }
                processKeyframes(false, function() {
                    busyPhoto = false;
                });
            });
        }
    }
}

function error(msg) {
    setTimeout(function(){
        intervalometer.emit("error", msg);
    }, 100);
}

camera.ptp.on('saveError', function(msg) {
    if (intervalometer.status.running) {
        intervalometer.cancel('err');
        error("Failed to save RAW image to SD card!\nTime-lapse has been stopped.\nPlease verify that the camera is set to RAW (not RAW+JPEG) and that the SD card is formatted and fully inserted into the VIEW.");
    }
});

intervalometer.validate = function(program) {
    var results = {
        errors: []
    };
    if (parseInt(program.delay) < 1) program.delay = 2;
    if(program.rampMode == 'fixed') {
        if (parseInt(program.frames) < 1) results.errors.push({param:'frames', reason: 'frame count not set'});
    } else {
        if(program.intervalMode == 'fixed' || program.rampMode == 'fixed') {
            if (parseInt(program.interval) < 2) results.errors.push({param:'interval', reason: 'interval not set or too short'});
        } else {
            if (parseInt(program.dayInterval) < 5) results.errors.push({param:'dayInterval', reason: 'dayInterval must be at least 5 seconds'});
            if (parseInt(program.nightInterval) < program.dayInterval) results.errors.push({param:'nightInterval', reason: 'nightInterval shorter than dayInterval'});
        }        
    }

    if(!camera.ptp.supports.destination && (program.destination != 'sd' || !camera.ptp.sdPresent)) {
        console.log("VAL: Error: SD card required");
        results.errors.push({param:false, reason: "SD card required. The connected camera (" + camera.ptp.model + ") does not support saving images to the camera.  Please insert an SD card into the VIEW and set the Destination to 'SD Card' so images can be saved to the card."});
    }

    var settingsDetails = camera.ptp.settings.details;

    if(!settingsDetails.iso || settingsDetails.iso.ev == null) {
        console.log("VAL: Error: invalid ISO setting", settingsDetails.iso);
        results.errors.push({param:false, reason: "invalid ISO setting on camera."});
    }

    if(!settingsDetails.shutter || settingsDetails.shutter.ev == null) {
        console.log("VAL: Error: invalid shutter setting", settingsDetails.shutter);
        results.errors.push({param:false, reason: "invalid shutter setting on camera."});
    }

    if(camera.ptp.settings && camera.ptp.settings.format != 'RAW' && program.destination == 'sd') {
        console.log("VAL: Error: camera not set to save in RAW");
        results.errors.push({param:false, reason: "camera must be set to save in RAW. The VIEW expects RAW files when processing images to the SD card (RAW+JPEG does not work)"});
    }

    console.log("VAL: validating program:", results);

    return results;
}
intervalometer.cancel = function(reason) {
    if(!reason) reason = 'stopped';
    if (intervalometer.status.running) {
        clearTimeout(timerHandle);
        clearTimeout(delayHandle);
        intervalometer.status.stopping = true;
        if(reason == 'err') intervalometer.status.message = "stopped due to error";
        else if(reason == 'done') intervalometer.status.message = "time-lapse complete";
        else intervalometer.status.message = "time-lapse canceled";
        intervalometer.status.framesRemaining = 0;
        intervalometer.emit("status", status);
        camera.ptp.completeWrites(function() {
            busyPhoto = false;
            intervalometer.status.running = false;
            intervalometer.status.stopping = false;
            intervalometer.timelapseFolder = false;
            camera.ptp.saveThumbnails(intervalometer.timelapseFolder);
            camera.ptp.unmountSd();
            intervalometer.emit("status", status);
            console.log("==========> END TIMELAPSE", status.tlName);
        });
    }
    power.performance('low');
}

intervalometer.run = function(program) {
    if (intervalometer.status.running) return;
    intervalometer.status.stopping = false;
    console.log("loading time-lapse program:", program);
    db.set('intervalometer.currentProgram', program);

    power.performance('high');

    if(program.manualAperture != null) camera.fixedApertureEv = program.manualAperture;

    if (camera.ptp.connected) {
        camera.ptp.getSettings(function(){
            var validationResults = intervalometer.validate(program);
            if (validationResults.errors.length == 0) {
                var tlIndex = fs.readFileSync(TLROOT + '/index.txt');
                if (!tlIndex) {
                    tlIndex = 1;
                } else {
                    tlIndex = parseInt(tlIndex) + 1;
                }
                fs.writeFileSync(TLROOT + '/index.txt', tlIndex.toString());
                status.tlName = "tl-" + tlIndex;
                console.log("==========> TIMELAPSE START", status.tlName);
                intervalometer.timelapseFolder = TLROOT + "/" + status.tlName;
                fs.mkdirSync(intervalometer.timelapseFolder);
                camera.ptp.saveThumbnails(intervalometer.timelapseFolder);
                status.timelapseFolder = intervalometer.timelapseFolder;
                fileInit();

                busyPhoto = false;
                intervalometer.currentProgram = program;
                status.intervalMs = program.interval * 1000;
                status.message = "starting";
                status.frames = 0;
                status.framesRemaining = (program.intervalMode == "auto" && program.rampMode == "auto") ? Infinity : program.frames;
                status.startTime = new Date() / 1000;
                status.rampEv = null;
                status.bufferSeconds = 0;
                if(mcu && mcu.lastGpsFix) {
                    status.latitude = mcu.lastGpsFix.lat;
                    status.longitude = mcu.lastGpsFix.lon;
                }
                exp.init(camera.minEv(camera.ptp.settings, getEvOptions()), camera.maxEv(camera.ptp.settings, getEvOptions()), program.nightCompensation);
                status.running = true;
                intervalometer.emit("status", status);
                console.log("program:", "starting", program);


                function start() {
                    var cameras = 1, primary = 1;
                    if(camera.ptp.synchronized) {
                        cameras = camera.ptp.count;
                        primary = camera.ptp.getPrimaryCameraIndex();
                    }
                    db.setTimelapse(status.tlName, program, cameras, primary, status, function(err, timelapseId) {
                        status.id = timelapseId;
                        processKeyframes(true, function() {
                            setTimeout(function() {
                                busyPhoto = false;
                                if(intervalometer.currentProgram.intervalMode != 'aux' || intervalometer.currentProgram.rampMode == 'fixed') {
                                    runPhoto();   
                                }
                                if(intervalometer.currentProgram.intervalMode == 'aux') {
                                    status.message = "waiting for AUX2...";
                                    intervalometer.emit("status", status);
                                }
                            }, 3000);
                        });
                    });
                    //delayHandle = setTimeout(function() {
                    //    runPhoto();
                    //}, program.delay * 1000);
                }

                if (program.destination && program.destination == 'sd' && camera.ptp.sdPresent) {
                    camera.ptp.mountSd(function(mountErr) {
                        if(mountErr) {
                            console.log("Error mounting SD card");
                            intervalometer.cancel('err');
                            error("Error mounting SD card. \nVerify the SD card is formatted and fully inserted in the VIEW, then try starting the time-lapse again.\nMessage from system: " + mountErr);
                        } else {
                            status.mediaFolder = "/media/" + status.tlName;
                            fs.mkdir(status.mediaFolder, function(folderErr) {
                                if(folderErr) {
                                    console.log("Error creating folder", status.mediaFolder);
                                    intervalometer.cancel('err');
                                    error("Error creating folder on SD card: /" + status.tlName + ".\nVerify the card is present and not write-protected, then try starting the time-lapse again.\nAlternatively, set the Destination to Camera instead (if supported)");
                                } else {
                                    start();
                                }
                            });
                        }
                    });
                } else {
                    start();
                }
            } else {
                var errorList = "";
                var val = "";
                for(var i = 0; i < validationResults.errors.length; i++) {
                    if(program.hasOwnProperty([validationResults.errors[i].param])) {
                        val = " (" + program[validationResults.errors[i].param] + ")";
                    } else {
                        val = "";
                    }
                    errorList += "- " + validationResults.errors[i].reason + val + "\n";
                }
                intervalometer.cancel('err');
                error("Failed to start time-lapse: \n" + errorList + "Please correct and try again.");
            }
        });
    } else {
        intervalometer.cancel('err');
        error("Camera not connected.  Please verify camera connection via USB and try again.");
        return;
    }

}



module.exports = intervalometer;