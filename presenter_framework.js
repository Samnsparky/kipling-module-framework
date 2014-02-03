/**
 * Event driven framework for easy module construction.
 *
 * @author: Chris Johnson (LabJack, 2014)
 * @author: Sam Pottinger (LabJack, 2014)
**/

var async = require('async');
var dict = require('dict');
var q = require('q');

var ljmmm_parse = require('ljmmm-parse');

var fs_facade = require('./fs_facade');

DEFAULT_REFRESH_RATE = 1000;


function cloneBindingInfo (original, binding, template) {
    return {
        class: original.class,
        template: template,
        binding: binding,
        direction: original.direction,
        event: original.event
    };
}


function expandBindingInfo (bindingInfo) {
    var expandedBindings = ljmmm_parse.expandLJMMMName(bindingInfo.binding);
    var expandedTemplates = ljmmm_parse.expandLJMMMName(bindingInfo.template);

    if (expandedBindings.length != expandedTemplates.length) {
        throw 'Unexpected ljmmm expansion mismatch.';
    }

    var newBindingsInfo = [];
    var numBindings = expandedBindings.length;
    for (var i=0; i<numBindings; i++) {
        var clone = cloneBindingInfo(
            bindingInfo,
            expandedBindings[i],
            expandedTemplates[i]
        );
        newBindingsInfo.push(clone);
    }

    return newBindingsInfo;
}


function Framework() {
    var eventListener = dict({
        moduleLoad: null,
        loadTemplate: null,
        deviceSelection: null,
        configureDevice: null,
        deviceConfigured: null,
        refresh: null,
        closeDevice: null,
        unloadModule: null,
        loadError: null,
        configError: null,
        refreshError: null,
        executionError: function (params) { throw params; }
    });
    this.eventListener = eventListener;

    var jquery = null;
    var refreshRate = DEFAULT_REFRESH_RATE;
    var configControls = [];
    var bindings = dict({});
    var readBindings = dict({});
    var writeBindings = dict({});
    var selectedDevices = [];

    this.jquery = jquery;
    this.refreshRate = refreshRate;
    this.configControls = configControls;
    this.bindings = bindings;
    this.readBindings = readBindings;
    this.writeBindings = writeBindings;
    this.selectedDevices = selectedDevices;

    var self = this;

    this._SetJQuery = function(newJQuery) {
        jquery = newJQuery
        this.jquery = newJQuery;
    };

    this._SetSelectedDevices = function(selectedDevices) {
        selectedDevices = selectedDevices
        this.selectedDevices = selectedDevices;
    };

    this.on = function (name, listener) {
        if (!eventListener.has(name)) {
            fire('loadError', {'msg': 'Config binding missing direction'});
            return;
        }

        eventListener.set(name, listener);
    };
    var on = this.on;

    this.fire = function (name, params) {
        if (!eventListener.has(name)) {
            return;
        }

        var listener = eventListener.get(name);

        if (listener)
            eventListener.get(name)(params);
    };
    var fire = this.fire;

    this.setRefreshRate = function (newRefreshRate) {
        this.refreshRate = newRefreshRate;
    };
    var setRefreshRate = this.setRefreshRate;

    this.setConfigControls = function (newConfigControls) {
        this.configControls = newConfigControls;
    };
    var setConfigControls = this.setConfigControls;

    this.putConfigBinding = function (newBinding) {

        if (newBinding['class'] === undefined) {
            fire('loadError', {'msg': 'Config binding missing class'});
            return;
        }

        if (newBinding['template'] === undefined) {
            fire('loadError', {'msg': 'Config binding missing template'});
            return;
        }

        if (newBinding['binding'] === undefined) {
            fire('loadError', {'msg': 'Config binding missing binding'});
            return;
        }

        if (newBinding['direction'] === undefined) {
            fire('loadError', {'msg': 'Config binding missing direction'});
            return;
        }

        var isWrite = newBinding['direction'] === 'write';
        if (isWrite && newBinding['event'] === undefined) {
            fire('loadError', {'msg': 'Config binding missing direction'});
            return;
        }

        var expandedBindings = expandBindingInfo(newBinding);
        var numBindings = expandedBindings.length;
        if (numBindings > 1) {
            for (var i=0; i<numBindings; i++)
                putConfigBinding(expandedBindings[i]);
            return;
        }

        bindings.set(newBinding.template, newBinding);
        

        var jquerySelector = '#' + newBinding.template;
        if (newBinding.direction === 'read') {
            readBindings.set(newBinding.template, newBinding);
        } else if (newBinding.direction === 'write') {
            writeBindings.set(newBinding.template, newBinding);
            jquery.on(
                jquerySelector,
                newBinding.event,
                function (event) {
                    self.fire('configureDevice', event);
                    var newVal = jquery.val(jquerySelector);
                    var device = getSelectedDevice();
                    device.write(newBinding.binding, newVal);
                    self.fire('deviceConfigured', event);
                }
            );
        } else {
            fire(
                'loadError',
                {'msg': 'Config binding has invalid direction'}
            );
        }
    };
    var putConfigBinding = this.putConfigBinding;

    this.deleteConfigBinding = function (bindingName) {
        var expandedBindings = ljmmm_parse.expandLJMMMName(bindingName);
        var numBindings = expandedBindings.length;
        if (numBindings > 1) {
            for (var i=0; i<numBindings; i++)
                deleteConfigBinding(expandedBindings[i]);
            return;
        }

        if (!this.bindings.has(bindingName)) {
            this.fire(
                'loadError',
                {'msg': 'No binding for ' + bindingName}
            );
            return;
        }

        var bindingInfo = this.bindings.get(bindingName);

        this.bindings.delete(bindingName);

        if (bindingInfo.direction === 'read') {
            this.readBindings.delete(bindingName);
        } else if (bindingInfo.direction === 'write') {
            this.writeBindings.delete(bindingName);
            var jquerySelector = '#' + bindingInfo.template;
            jquery.off(jquerySelector, bindingInfo.event);
        } else {
            this.fire(
                'loadError',
                {'msg': 'Config binding has invalid direction'}
            );
        }
    };
    var deleteConfigBinding = this.deleteConfigBinding;

    this.setDeviceView = function (templateLoc, jsonFiles, context) {
        if (jsonFiles === undefined)
            jsonFiles = [];

        if (context === undefined)
            context = {};

        // Create an error handler
        var fireMethod = this.fire;
        var reportLoadError = function (details) {
            fireMethod('loadError', {'msg': details});
        };

        // Load the supporting JSON files for use in the template
        var jsonTemplateVals = {};
        var loadJSONFiles = function () {
            var deferred = q.defer();
            async.eachSeries(
                jsonFiles,
                function (location, callback) {
                    var fullURI = fs_facade.getExternalURI(location);
                    fs_facade.getJSON(
                        fullURI,
                        callback,
                        function (result) {
                            var name = location.replace(/\.json/g, '');
                            jsonTemplateVals[name] = result;
                            callback(null); 
                        }
                    );
                },
                function (err) {
                    if (err)
                        deferred.reject(err);
                    else
                        deferred.resolve();
                }
            );
            return deferred.promise;
        };

        // Load the HTML view template and render
        var prepareHTMLTemplate = function () {
            var deferred = q.defer();
            var fullURI = fs_facade.getExternalURI(templateLoc);
            context.json = jsonTemplateVals;
            fs_facade.renderTemplate(
                fullURI,
                context,
                deferred.reject,
                deferred.resolve
            );
            return deferred.promise;
        };

        loadJSONFiles()
        .then(prepareHTMLTemplate, reportLoadError)
        .fail(reportLoadError);
    };
    var setDeviceView = this.setDeviceView;

    this.getSelectedDevice = function () {
        if (self.selectedDevices.length == 0)
            return null;
        else
            return self.selectedDevices[0];
    };
    var getSelectedDevice = this.getSelectedDevice;

    this.establishConfigControlBindings = function () {
        var listener = this._OnConfigControlEvent;
        var jquery = this.jquery;
        this.configControls.forEach(function (value) {
            jquery.on(value.selector, value.event, listener);
        });
    };

    this.numBindings = function () {

    };
    var numBindings = this.numBindings;

    this._OnRead = function (valueReadFromDevice) {
        var jquery = this.jquery;
        this.readBindings.forEach(function (bindingInfo, template) {
            var bindingName = bindingInfo.binding;
            var valRead = valueReadFromDevice[bindingName];
            if (valRead !== undefined) {
                var jquerySelector = '#' + bindingInfo.template;
                jquery.html(jquerySelector, valRead);
            }
        });
    };
    var _OnRead = _OnRead;

    this._OnConfigControlEvent = function (event) {
        fire('configureDevice', event);
        fire('deviceConfigured', event);
    };
    var _OnConfigControlEvent = _OnConfigControlEvent;
}


exports.Framework = Framework
