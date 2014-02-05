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

var DEFAULT_REFRESH_RATE = 1000;
var DEVICE_VIEW_TARGET = '#device-view';

function JQueryWrapper (origJQuery) {
    this.html = function (selector, newHTML) {
        $(selector).html(newHTML);
    };

    this.on = function (selector, event, listener) {
        $(selector).on(event, listener);
    };

    this.find = function (selector) {
        return $(selector);
    };

    this.val = function (selector) {
        return $(selector).val();
    };
}


/**
 * Creates a new binding info object with the metadata copied from another.
 *
 * Creates a new binding info object, a structure with all of the information
 * necessary to bind a piece of the module GUI to a register / registers on
 * a LabJack device. This will copy the "metadata" from an existing binding
 * into a new one. Namely, it will re-use original's class, direction, and
 * event attributes but add in new binding and template values.
 * 
 * @param {Object} orginal The object with the original binding information.
 * @param {String} binding The register name to bind the GUI element(s) to.
 *      If given an LJMMM string, will be exapnded and all registers named after
 *      the expansion will be bound to the GUI. Note that this expansion
 *      is executed later in the framework and only a single binding will be
 *      returned from this function.
 * @param {String} template The template for the GUI element ID to bind. This
 *      should coorespond to a HTML element IDs. May contain LJMMM and, if
 *      given an LJMMM string, will be expanded and matched to the registers
 *      listed in binding parameter. Note that this expansion
 *      is executed later in the framework and only a single binding will be
 *      returned from this function.
 * @return {Object} New binding.
**/
function cloneBindingInfo (original, binding, template) {
    return {
        class: original.class,
        template: template,
        binding: binding,
        direction: original.direction,
        event: original.event
    };
}


/**
 * Expands the LJMMM in the binding and template names.
 *
 * Each binding info object has a binding attribute with the name of the
 * register on the device to bind from as well as a template attribute that
 * specifies the ID of the HTML element to bind to. So, binding AIN0 and
 * template analog-input-0 would bind the device register for AIN0 to 
 * the HTML element with the id analog-input-0. This function will exapnd
 * LJMMM names found in either the template or binding attributes. Binding
 * AIN#(0:1) will exapnd to [AIN0, AIN1] and analog-input-#(0:1) will expand
 * to [analog-input-0, analog-input-1].
 *
 * @param {Object} bindingInfo The object with info about the binding to
 *      expand.
 * @return {Array} Array containing all of the bindings info objects that
 *      resulted from expanding the LJMMM found in original binding info
 *      object's binding and template attributes. If no LJMMM was in the
 *      original binding info object's binding or template attributes, an Array
 *      with a single binding info object will be returned.
**/
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


/**
 * Object that manages the modules using the Kipling Module Framework.
**/
function Framework() {

    // List of events that the framework handels
    var eventListener = dict({
        onModuleLoad: null,
        onDeviceSelection: null,
        onTemplateLoaded: null,
        onRegisterWrite: null,
        onRegisterWritten: null,
        onRefresh: null,
        onRefreshed: null,
        onCloseDevice: null,
        onUnloadModule: null,
        onLoadError: null,
        onConfigError: null,
        onRefreshError: null,
        onExecutionError: function (params) { throw params; }
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
    this.runLoop = false;

    var self = this;

    this._SetJQuery = function(newJQuery) {
        jquery = newJQuery
        this.jquery = newJQuery;
    };

    this._SetSelectedDevices = function(selectedDevices) {
        selectedDevices = selectedDevices
        self.selectedDevices = selectedDevices;
    };

    /**
     * Set the callback that should be called for an event.
     *
     * Indicate which function (callback) should be called when the framework
     * encounters each event. Note that previous event listeners for that event
     * will be cleared by calling this.
     *
     * @param {String} name The name of the event to register a callback for.
     * @param {function} listener The function to call when that event is
     *      encountered. Should take a single argument: an object whose
     *      attributes are parameters supplied to the event.
    **/
    this.on = function (name, listener) {
        if (!eventListener.has(name)) {
            self.fire(
                'onLoadError',
                [ 'Config binding missing direction' ],
                function (shouldContinue) { self.runLoop = shouldContinue; }
            );
            return;
        }

        eventListener.set(name, listener);
    };
    var on = this.on;

    /**
     * Force-cause an event to occur through the framework.
     *
     * @param {String} name The name of the event to fire.
     * @param {Object} params Object whose attributes should be used as
     *      parameters for the event.
     * @param {function} onErr Function to call if an error was encountered
     *      while running event listeneres. Optional.
     * @param {function} onSuccess Function to call after the event listeners
     *      finish running. Optional.
    **/
    this.fire = function (name, params, onErr, onSuccess) {
        var noop = function () {};

        if (!params)
            params = [];

        if (!onSuccess)
            onSuccess = noop;

        if (!onErr)
            onErr = noop;

        if (!eventListener.has(name)) {
            onSuccess();
            return;
        }

        var listener = eventListener.get(name);

        if (listener !== null) {
            var passParams = [];
            passParams.push(self);
            passParams.push.apply(passParams, params)
            passParams.push(onErr);
            passParams.push(onSuccess);
            listener.apply(null, passParams);
        } else {
            onSuccess();
        }
    };
    var fire = this.fire;

    /**
     * Set how frequently the framework should read from the device.
     *
     * @param {int} newRefreshRate The number of milliseconds between updates.
    **/
    this.setRefreshRate = function (newRefreshRate) {
        self.refreshRate = newRefreshRate;
    };
    var setRefreshRate = this.setRefreshRate;

    /**
     * Indicate which HTML controls should cause device configured to fire.
     *
     * Indicate which HTML controls (not bound through putConfigBinding) that
     * should cause a device configured event to be fired when they have an
     * event within the HTML view. This could, for example, be a button to
     * write values to a device.
     *
     * @param {Array} newConfigControls An array of Object where each element
     *      has an event attribute with the name of the event to listen for
     *      on the HTML element and a selector attribute which should be a 
     *      jQuery selector for the HTML elements to bind the event listener
     *      to.
    **/
    this.setConfigControls = function (newConfigControls) {
        self.configControls = newConfigControls;
    };
    var setConfigControls = this.setConfigControls;

    /**
     * Register a new configuration binding.
     *
     * Register a new configuration binding that either cuases an HTML element
     * to act as a (frequently updated) display for the value of a register
     * or as an HTML element that allows the user to write the value of
     * a device register. This device binding info object should have
     * attributes:
     *
     * <ul>
     *   <li>{string} class: Description of what type of binding this is. Not
     *          used in this first release of this framework.</li>
     *   <li>{string} template: The ID of the HTML element to bind to. For
     *          example: ain-0-display or ain-#(0:1)-display.</li>
     *   <li>{string} binding: The name of the device register to bind to. For
     *          exmaple: AIN0 or AIN#(0:1).</li>
     *   <li>{string} direction: Either "read" for displaying a the value of a
     *          device register or "write" for having an HTML element set the
     *          value of a device register. May also be "hybrid" which will
     *          first read the current value of a register, display that, and
     *          then update the value of that register on subsequent updates
     *          from within the view.</li>
     *   <li>{string} event: The name of the event to bind to. Only required if
     *          write or hybrid. For example, "change" would cause the value to
     *          be written to the device each time an input box value is
     *          changed.</li>
     * </ul>
     *
     * Note that template and binding can contain LJMMM strings. If they do,
     * they will automagically be expanded and bound individually. So, template
     * of analog-#(0:1)-display and binding of AIN#(0:1) will bind
     * analog-0-display to AIN0 and analog-1-display to AIN1.
     *
     * @param {Object} newBinding The binding information object (as described
     *      above) that should be registered.
    **/
    this.putConfigBinding = function (newBinding) {
        var onErrorHandle = function (shouldContinue) {
            self.runLoop = shouldContinue;
        }

        if (newBinding['class'] === undefined) {
            self.fire(
                'onLoadError',
                [ 'Config binding missing class' ],
                onErrorHandle
            );
            return;
        }

        if (newBinding['template'] === undefined) {
            self.fire(
                'onLoadError',
                [ 'Config binding missing template' ],
                onErrorHandle
            );
            return;
        }

        if (newBinding['binding'] === undefined) {
            self.fire(
                'onLoadError',
                [ 'Config binding missing binding' ],
                onErrorHandle
            );
            return;
        }

        if (newBinding['direction'] === undefined) {
            self.fire(
                'onLoadError',
                [ 'Config binding missing direction' ],
                onErrorHandle
            );
            return;
        }

        var isWrite = newBinding['direction'] === 'write';
        if (isWrite && newBinding['event'] === undefined) {
            self.fire(
                'onLoadError',
                [ 'Config binding missing direction' ],
                onErrorHandle
            );
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
                function () { self._writeToDevice(newBinding); }
            );
        } else {
            self.fire(
                'onLoadError',
                [ 'Config binding has invalid direction' ],
                onErrorHandle
            );
        }
    };
    var putConfigBinding = this.putConfigBinding;

    this._writeToDevice = function (bindingInfo) {
        var jquerySelector = '#' + bindingInfo.template;
        var newVal = self.jquery.val(jquerySelector);

        var alertRegisterWrite = function () {
            var innerDeferred = q.defer();
            self.fire(
                'onRegisterWrite',
                [
                    bindingInfo.binding,
                    newVal
                ],
                innerDeferred.reject,
                innerDeferred.resolve
            );
            return innerDeferred.promise;
        };

        var writeToDevice = function () {
            var innerDeferred = q.defer();
            var device = self.getSelectedDevice();
            device.write(bindingInfo.binding, newVal);
            innerDeferred.resolve();
            return innerDeferred.promise;
        }

        var alertRegisterWritten = function () {
            var innerDeferred = q.defer();
            self.fire(
                'onRegisterWritten',
                [
                    bindingInfo.binding,
                    newVal
                ],
                innerDeferred.reject,
                innerDeferred.resolve
            );
            return innerDeferred.promise;
        };

        var deferred = q.defer();
        alertRegisterWrite()
        .then(writeToDevice, deferred.reject)
        .then(alertRegisterWritten, deferred.reject)
        .then(deferred.resolve, deferred.reject);
    }

    /**
     * Delete a previously added configuration binding.
     *
     * @param {String} bindingName The name of the binding (the binding info
     *      object's original "template" attribute) to delete.
    **/
    this.deleteConfigBinding = function (bindingName) {
        var expandedBindings = ljmmm_parse.expandLJMMMName(bindingName);
        var numBindings = expandedBindings.length;
        if (numBindings > 1) {
            for (var i=0; i<numBindings; i++)
                deleteConfigBinding(expandedBindings[i]);
            return;
        }

        if (!self.bindings.has(bindingName)) {
            self.fire(
                'onLoadError',
                [ 'No binding for ' + bindingName ],
                function (shouldContinue) { self.runLoop = shouldContinue; }
            );
            return;
        }

        var bindingInfo = this.bindings.get(bindingName);

        self.bindings.delete(bindingName);

        if (bindingInfo.direction === 'read') {
            self.readBindings.delete(bindingName);
        } else if (bindingInfo.direction === 'write') {
            self.writeBindings.delete(bindingName);
            var jquerySelector = '#' + bindingInfo.template;
            jquery.off(jquerySelector, bindingInfo.event);
        } else {
            self.fire(
                'onLoadError',
                [ 'Config binding has invalid direction' ],
                function (shouldContinue) { self.runLoop = shouldContinue; }
            );
        }
    };
    var deleteConfigBinding = this.deleteConfigBinding;

    /**
     * Render the HTML view to use for the current module.
     *
     * @param {str} templateLoc Path to the HTML template to use to render this
     *      module's view. Will be rendered as a handlebars template.
     * @param {Array} jsonFiles String paths to the JSON files to use when
     *      rendering this view. Will be provided to the template as an
     *      attribute "json" on the rendering context. Namely, context.json will
     *      be set to an object where the attribute is the name of the JSON file
     *      and the value is the JSON loaded from that file.
     * @param {function} onErr The function to call if an error was encountered
     *      while rendering the module view. Optional.
     * @param {function} onSuccess The function to call after the view has been
     *      rendered.
    **/
    this.setDeviceView = function (loc, jsonFiles, context, onErr, onSuccess) {
        var noop = function () {};

        if (jsonFiles === undefined)
            jsonFiles = [];

        if (context === undefined)
            context = {};

        if (!onErr)
            onErr = noop;

        if (!onSuccess)
            onSuccess = noop;

        // Create an error handler
        var reportLoadError = function (details) {
            onErr({'msg': details});
            self.fire(
                'onLoadError',
                [ details ],
                function (shouldContinue) { self.runLoop = shouldContinue; }
            );
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
            var fullURI = fs_facade.getExternalURI(loc);
            context.json = jsonTemplateVals;
            fs_facade.renderTemplate(
                fullURI,
                context,
                deferred.reject,
                deferred.resolve
            );
            return deferred.promise;
        };

        var injectHTMLTemplate = function (htmlContents) {
            var deferred = q.defer();
            self.jquery.html(DEVICE_VIEW_TARGET, htmlContents);
            deferred.resolve();
            return deferred.promise;
        };

        var attachListeners = function () {
            self.jquery.on(
                '.device-selection-radio',
                'click',
                self._changeSelectedDeviceUI
            );
            self.jquery.find('.device-selection-radio').first().prop(
                'checked', true);
        };

        loadJSONFiles()
        .then(prepareHTMLTemplate, reportLoadError)
        .then(injectHTMLTemplate, reportLoadError)
        .then(attachListeners, reportLoadError)
        .then(onSuccess, reportLoadError);
    };
    var setDeviceView = self.setDeviceView;

    this._changeSelectedDeviceUI = function () {
        var selectedCheckboxes = $('.device-selection-radio:checked');

        var handleError = function (err) {
            this.fire(
                'onLoadError',
                [
                    self,
                    err,
                    function (shouldContinue) { self.runLoop = shouldContinue; }
                ]
            );
        }

        var selectedDevices = $('.device-selection-radio:checked').map(
            function () {
                var numDevices = devices.length;
                var serial = this.id.replace('-selector', '');
                for (var i=0; i<numDevices; i++) {
                    if (devices[i].getSerial() === serial)
                        return devices[i];
                }
                return null;
            }
        );
        this._SetSelectedDevices([selectedDevices[0]]);

        this.fire(
            'onDeviceSelection',
            [self, handleError, function () {}]
        );
    };

    /**
     * Get the currently selected device.
     *
     * @return {presenter.Device} The device selected as the "active" device.
    **/
    this.getSelectedDevice = function () {
        if (self.selectedDevices.length == 0)
            return null;
        else
            return self.selectedDevices[0];
    };
    var getSelectedDevice = this.getSelectedDevice;

    /**
     * Function that should be called after all of the bindings have been added.
     *
     * Function that should be called after all of the config bindings have been
     * added and all of the config controls have been set.
    **/
    this.establishConfigControlBindings = function () {
        var listener = self._OnConfigControlEvent;
        var jquery = self.jquery;
        self.configControls.forEach(function (value) {
            jquery.on(value.selector, value.event, listener);
        });
    };

    /**
     * Stop the module's refresh loop.
    **/
    this.stopLoop = function () {
        self.runLoop = false;
    };
    var stopLoop = this.stopLoop;

    /**
     * Start the module's refresh loop.
    **/
    this.startLoop = function () {
        self.runLoop = true;
        self.loopIteration();
    };
    var startLoop = this.startLoop;

    /**
     * Function to run a single iteration of the module's refresh loop.
     *
     * @return {q.promise} Promise that resolves after the iteration of the
     *      refresh loop finishes running. Rejects if an error was encountered
     *      during the loop iteration.
    **/
    this.loopIteration = function () {
        var deferred = q.defer();

        if (!self.runLoop) {
            deferred.reject('Loop not running.');
            return deferred.promise;
        }

        var reportError = function (details) {
            self.fire(
                'onRefreshError',
                [ 'Failed loop iteration.' ],
                function (shouldContinue) { self.runLoop = shouldContinue; }
            );
            deferred.reject(details);
        };

        var getNeededAddresses = function () {
            var innerDeferred = q.defer();
            var addresses = [];

            self.readBindings.forEach(function (value, key) {
                addresses.push(value.binding);
            });

            innerDeferred.resolve(addresses);
            return innerDeferred.promise;
        };

        var alertRefresh = function (addresses) {
            var innerDeferred = q.defer();
            self.fire(
                'onRefresh',
                [ addresses ],
                innerDeferred.reject,
                function () { innerDeferred.resolve(addresses); }
            );
            return innerDeferred.promise;
        };

        var requestDeviceValues = function (addresses) {
            var innerDeferred = q.defer();
            var device = self.getSelectedDevice();
            
            device.readMany(addresses)
            .then(
                function (values) {
                    innerDeferred.resolve({
                        values: values,
                        addresses: addresses
                    });
                },
                innerDeferred.reject
            );

            return innerDeferred.promise;
        };

        var processDeviceValues = function (valuesInfo) {
            var innerDeferred = q.defer();
            var values = valuesInfo.values;
            var addresses = valuesInfo.addresses;
            var numAddresses = addresses.length;
            var retDict = dict();

            for (var i=0; i<numAddresses; i++) {
                retDict.set(addresses[i].toString(), values[i]);
            }

            innerDeferred.resolve(retDict);
            return innerDeferred.promise;
        };

        var alertOn = function (valuesDict) {
            var innerDeferred = q.defer();
            self._OnRead(valuesDict);
            innerDeferred.resolve(valuesDict);
            return innerDeferred.promise;
        };

        var alertRefreshed = function (valuesDict) {
            var innerDeferred = q.defer();
            self.fire(
                'onRefreshed',
                [ valuesDict ],
                innerDeferred.reject,
                function () { innerDeferred.resolve(); }
            );
            return innerDeferred.promise;
        };

        var setTimeout = function () {
            var innerDeferred = q.defer();
            //setTimeout(self.loopIteration, 10000);
            innerDeferred.resolve();
            return innerDeferred.promise;
        };

        getNeededAddresses()
        .then(alertRefresh, reportError)
        .then(requestDeviceValues, reportError)
        .then(processDeviceValues, reportError)
        .then(alertOn, reportError)
        .then(alertRefreshed, reportError)
        .then(setTimeout, reportError)
        .then(deferred.resolve, deferred.reject);

        return deferred.promise;
    };
    var loopIteration = this.loopIteration;

    /**
     * Determine how many bindings have been registered for the module.
     *
     * @return {int} The number of bindings registered for this module.
    **/
    this.numBindings = function () {
        return self.bindings.size();
    };
    var numBindings = this.numBindings;

    this._OnRead = function (valueReadFromDevice) {
        var jquery = self.jquery;
        self.readBindings.forEach(function (bindingInfo, template) {
            var bindingName = bindingInfo.binding;
            var valRead = valueReadFromDevice.get(bindingName.toString());
            if (valRead !== undefined) {
                var jquerySelector = '#' + bindingInfo.template;
                jquery.html(jquerySelector, valRead);
            }
        });
    };
    var _OnRead = _OnRead;

    this._OnConfigControlEvent = function (event) {
        self.fire('onRegisterWrite', [event]);
        self.fire('onRegisterWritten', [event]);
    };
    var _OnConfigControlEvent = _OnConfigControlEvent;
}


exports.Framework = Framework
