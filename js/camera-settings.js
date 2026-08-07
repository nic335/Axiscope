// Camera Settings panel: live v4l2-ctl controls for the physical camera,
// served by Axiscope's own Flask backend (co-located with the camera).

let v4l2SelectedDevice = null;
const v4l2SendTimeouts = {};

function v4l2SetStatus(msg, isError) {
    const $status = $('#v4l2-controls-status');
    $status.text(msg || '');
    $status.toggleClass('text-danger', !!isError);
}

function v4l2LoadDevices() {
    v4l2SetStatus('Loading devices...');
    $('#v4l2-controls-container').empty();

    $.get('/api/v4l2/devices', function(data) {
        const devices = (data && data.devices) || [];
        const $wrap = $('#v4l2-device-select-wrap');
        const $select = $('#v4l2-device-select');
        $select.empty();

        if (devices.length === 0) {
            v4l2SetStatus('No V4L2 capture devices found on this host.', true);
            $wrap.hide();
            return;
        }

        devices.forEach(function(dev) {
            $select.append(
                $('<option>').val(dev.path).text(dev.name + ' (' + dev.path + ')')
            );
        });

        if (devices.length > 1) {
            $wrap.show();
        } else {
            $wrap.hide();
        }

        v4l2SelectedDevice = devices[0].path;
        $select.val(v4l2SelectedDevice);
        v4l2LoadControls(v4l2SelectedDevice);
    }).fail(function() {
        v4l2SetStatus('Failed to load V4L2 devices.', true);
    });
}

function v4l2LoadControls(devicePath) {
    v4l2SetStatus('Loading controls...');
    $('#v4l2-controls-container').empty();

    $.get('/api/v4l2/controls', { device: devicePath }, function(data) {
        const groups = (data && data.groups) || {};
        const $container = $('#v4l2-controls-container');
        $container.empty();

        const categories = Object.keys(groups);
        if (categories.length === 0) {
            v4l2SetStatus('No controls reported for this device.', true);
            return;
        }

        v4l2SetStatus('');

        categories.forEach(function(category) {
            const controls = groups[category];
            if (!controls || controls.length === 0) return;

            $container.append(
                $('<h6>').addClass('text-secondary text-uppercase mt-3 mb-2')
                    .css('font-size', '11px').css('letter-spacing', '0.05em')
                    .text(category)
            );

            controls.forEach(function(ctrl) {
                $container.append(v4l2RenderControl(devicePath, ctrl));
            });
        });
    }).fail(function() {
        v4l2SetStatus('Failed to load controls for this device.', true);
    });
}

function v4l2RenderControl(devicePath, ctrl) {
    const rowId = 'v4l2-ctrl-' + ctrl.name;
    const $row = $('<div>').addClass('mb-3 v4l2-control-row').attr('id', rowId);
    if (ctrl.inactive) {
        $row.addClass('v4l2-control-inactive');
    }

    const $label = $('<div>').addClass('d-flex justify-content-between align-items-center mb-1');
    $label.append($('<label>').addClass('form-label mb-0').text(ctrl.name.replace(/_/g, ' ')));

    if (ctrl.type === 'bool') {
        const $switchWrap = $('<div>').addClass('form-check form-switch');
        const $input = $('<input>').attr('type', 'checkbox').addClass('form-check-input')
            .prop('checked', !!ctrl.value).prop('disabled', !!ctrl.inactive);
        $switchWrap.append($input);
        $row.append($label).append($switchWrap);

        $input.on('change', function() {
            v4l2SendControl(devicePath, ctrl.name, $input.is(':checked') ? 1 : 0);
        });
    } else if (ctrl.type === 'menu') {
        const $valueBadge = $('<span>').addClass('text-secondary small').text(ctrl.value);
        $label.append($valueBadge);

        const $select = $('<select>').addClass('form-select form-select-sm')
            .prop('disabled', !!ctrl.inactive);

        (ctrl.menu_options || []).forEach(function(opt, i) {
            const idx = (ctrl.menu_indices && ctrl.menu_indices[i] !== undefined)
                ? ctrl.menu_indices[i] : i;
            $select.append($('<option>').val(idx).text(opt));
        });
        $select.val(ctrl.current_menu_idx);

        $row.append($label).append($select);

        $select.on('change', function() {
            const idx = $select.val();
            const selectedText = $select.find('option:selected').text();
            $valueBadge.text(selectedText);
            v4l2SendControl(devicePath, ctrl.name, idx);
        });
    } else {
        // int
        const $valueBadge = $('<span>').addClass('text-secondary small').text(ctrl.value);
        $label.append($valueBadge);

        const $slider = $('<input>').attr('type', 'range').addClass('form-range')
            .attr('min', ctrl.min).attr('max', ctrl.max).attr('step', ctrl.step)
            .val(ctrl.value).prop('disabled', !!ctrl.inactive);

        $row.append($label).append($slider);

        $slider.on('input', function() {
            $valueBadge.text($slider.val());
            clearTimeout(v4l2SendTimeouts[ctrl.name]);
            v4l2SendTimeouts[ctrl.name] = setTimeout(function() {
                v4l2SendControl(devicePath, ctrl.name, $slider.val());
            }, 150);
        });
    }

    return $row;
}

function v4l2SendControl(devicePath, controlName, value) {
    $.ajax({
        url: '/api/v4l2/set_control',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ device: devicePath, control: controlName, value: value }),
        success: function(resp) {
            if (!resp || !resp.success) {
                v4l2SetStatus('Failed to set ' + controlName, true);
            }
        },
        error: function() {
            v4l2SetStatus('Failed to set ' + controlName, true);
        }
    });
}

$(document).ready(function() {
    $('#open-camera-settings').on('click', function() {
        v4l2LoadDevices();
        const panelEl = document.getElementById('cameraSettingsPanel');
        const offcanvas = bootstrap.Offcanvas.getOrCreateInstance(panelEl);
        offcanvas.show();
    });

    $('#v4l2-device-select').on('change', function() {
        v4l2SelectedDevice = $(this).val();
        v4l2LoadControls(v4l2SelectedDevice);
    });
});
