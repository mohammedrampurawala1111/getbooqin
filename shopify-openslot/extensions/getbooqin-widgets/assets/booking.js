/**
 * GetBooqin booking wizard for Shopify. No framework, no build step.
 *
 * Ported from the WordPress plugin's assets/js/booking.js. The one structural
 * difference: there is no server-rendered `GetBooqinConfig` global here, since
 * Liquid can't localize a script the way `wp_localize_script()` did. Instead
 * this file calls `/apps/getbooqin/config` itself on first run. That path is
 * relative to the current storefront page, so Shopify's App Proxy (configured
 * in shopify.app.toml) transparently forwards it to the app, signed, with no
 * nonce or nonce header needed — the proxy signature *is* the auth.
 */
( function () {
	'use strict';

	// Both the manually-placed booking-widget.liquid block and the
	// product-booking-embed.liquid app embed load this same file, so a page
	// that has both active would otherwise execute this IIFE twice and
	// double-register the DOMContentLoaded handler below.
	if ( window.__getbooqinBookingInit ) {
		return;
	}
	window.__getbooqinBookingInit = true;

	var API_BASE = '/apps/getbooqin/';

	var t = {
		chooseService: 'Choose a service',
		chooseStaff: 'Choose who you would like to see',
		anyAvailable: 'Anyone available',
		chooseAddons: 'Anything else you would like to add?',
		continueLabel: 'Continue',
		chooseDate: 'Pick a date',
		yourDetails: 'Your details',
		firstName: 'First name',
		lastName: 'Last name',
		email: 'Email address',
		phone: 'Phone number',
		notes: 'Anything we should know?',
		back: 'Back',
		confirm: 'Confirm booking',
		loading: 'Loading…',
		noSlots: 'No times available on this day.',
		booked: 'You are booked!',
		bookedIntro: 'We have emailed you the details.',
		required: 'Please fill in the required fields.',
		genericError: 'Something went wrong. Please try again.',
		min: 'min',
		send: 'Send',
		cancelBooking: 'Cancel this booking',
		cancelConfirm: 'Are you sure you want to cancel?',
		cancelled: 'This booking has been cancelled.',
		rescheduleBooking: 'Reschedule',
		rescheduled: 'Your booking has been moved.',
		pickNewDate: 'Pick a new date',
		pickDatePrompt: 'Select a date to see available times.',
		timezoneLabel: 'Timezone',
		serviceLabel: 'Service',
		teamMemberLabel: 'Team Member',
		selectTimeSlot: 'Select preferred time slot',
		selectTimeHint: 'Please select a time slot',
		payNow: 'Pay now',
		choosePayment: 'How would you like to pay?',
		amountDue: 'Amount due',
		payLater: 'I will pay later',
		paymentDone: 'Payment received. Thank you!',
		redirecting: 'Taking you to the payment page…',
		videoNote: 'This is a video call. Your join link is in your confirmation email.',
		joinCall: 'Join the video call',
		bookNow: 'Book now',
		close: 'Close'
	};

	var configPromise = null;
	function config() {
		if ( ! configPromise ) {
			// Merchant overrides for the widget's copy (Settings -> Widget) land
			// on cfg.widget_text — applied once, here, so every caller of
			// config() picks them up without repeating the merge. Anything
			// rendered before the first config() resolves (the very first
			// "Loading…" flash) still uses the built-in default; there's no
			// way around that without server-rendering the widget's strings.
			configPromise = api( 'config' ).then( function ( cfg ) {
				if ( cfg && cfg.widget_text ) {
					Object.keys( cfg.widget_text ).forEach( function ( key ) {
						if ( cfg.widget_text[ key ] ) {
							t[ key ] = cfg.widget_text[ key ];
						}
					} );
				}
				return cfg;
			} );
		}
		return configPromise;
	}

	// The inline block and the floating embed can both be active on one
	// product page, and each calls initProductEmbed independently — cache by
	// handle so that only fires one request instead of two.
	var productServicePromises = {};
	function productService( handle ) {
		if ( ! productServicePromises[ handle ] ) {
			productServicePromises[ handle ] = api( 'product-service?handle=' + encodeURIComponent( handle ) );
		}
		return productServicePromises[ handle ];
	}

	// Cached by serviceId (or a composite key for days, since that also
	// depends on resource/month/add-ons) rather than per-Wizard-instance, so
	// prefetchBooking() below can start these the moment a product page
	// finds it has a linked service — before the visitor has even found the
	// "Book now" button, let alone clicked it. By the time they do click,
	// this data usually already resolved in the background, and
	// openBookingModal only has to *render*, not wait on the network. Any
	// Wizard instance that asks for the same key later just reuses whatever
	// is (or isn't yet) in flight.
	var resourcesPromises = {};
	function resourcesFor( serviceId ) {
		if ( ! resourcesPromises[ serviceId ] ) {
			resourcesPromises[ serviceId ] = api( 'resources?service_id=' + serviceId );
		}
		return resourcesPromises[ serviceId ];
	}

	var addonsPromises = {};
	function addonsFor( serviceId ) {
		if ( ! addonsPromises[ serviceId ] ) {
			addonsPromises[ serviceId ] = api( 'addons?service_id=' + serviceId );
		}
		return addonsPromises[ serviceId ];
	}

	var daysPromises = {};
	function daysFor( serviceId, resourceId, year, month, addonIds ) {
		var key = serviceId + ':' + resourceId + ':' + year + '-' + month + ':' + addonIds.join( ',' );
		if ( ! daysPromises[ key ] ) {
			daysPromises[ key ] = api(
				'days?service_id=' + serviceId + '&resource_id=' + resourceId + '&year=' + year + '&month=' + month + '&addon_ids=' + addonIds.join( ',' )
			).then( function ( days ) {
				var map = {};
				days.forEach( function ( d ) { map[ d.date ] = d.count; } );
				return map;
			} );
		}
		return daysPromises[ key ];
	}

	/**
	 * Fires as soon as a product page confirms it has a linked service —
	 * config, resources and add-ons only depend on serviceId, so there's no
	 * reason to wait for a click to start them. When the common case holds
	 * (one resource, no add-ons — the same auto-advance path stepResource/
	 * stepAddons take), this also speculatively prefetches the current
	 * month's calendar, since that's the one request that genuinely can't
	 * start until resourceId is resolved. A merchant with multiple staff or
	 * real add-ons just won't get that last speculative hit — the actual
	 * wizard still fetches it correctly once the visitor makes a choice.
	 */
	function prefetchBooking( serviceId ) {
		config();
		resourcesFor( serviceId ).then( function ( resources ) {
			if ( resources.length > 1 ) {
				return;
			}
			var resourceId = resources.length ? resources[ 0 ].id : 0;
			addonsFor( serviceId ).then( function ( addons ) {
				if ( addons.length ) {
					return;
				}
				var now = new Date();
				daysFor( serviceId, resourceId, now.getFullYear(), now.getMonth() + 1, [] );
			} );
		} );
	}

	function api( path, options ) {
		options = options || {};
		options.headers = Object.assign( { 'Content-Type': 'application/json' }, options.headers || {} );
		return fetch( API_BASE + path, options ).then( function ( response ) {
			return response.json().then( function ( json ) {
				if ( ! response.ok || false === json.success ) {
					var err = new Error( ( json && json.message ) || t.genericError );
					// initProductEmbed needs to tell "the proxy/app is down"
					// (a real 5xx it should surface) apart from "clean 200
					// answer, just nothing linked" (never throws here at all —
					// see product-service.tsx, which returns { service: null }
					// rather than an error for that case).
					err.status = response.status;
					throw err;
				}
				return json.data;
			} );
		}, function ( networkErr ) {
			// fetch() itself rejected — offline, DNS, CORS, etc. No HTTP
			// status exists yet, but this is exactly as real a failure as a
			// 5xx from the app's point of view.
			networkErr.status = 0;
			throw networkErr;
		} );
	}

	/**
	 * Body.innerHTML is cleared and rebuilt on every step transition, which
	 * silently drops focus back to <body> — disorienting for keyboard/screen
	 * reader users mid-wizard, since nothing tells them the step changed or
	 * where the new content starts. Moving focus to each step's own heading
	 * (a plain non-interactive element, so tabindex="-1" is required for it
	 * to be focusable at all) re-orients them at the top of the new step.
	 */
	function focusHeading( heading ) {
		if ( ! heading ) {
			return;
		}
		heading.setAttribute( 'tabindex', '-1' );
		heading.focus();
	}

	function el( tag, attrs, children ) {
		var node = document.createElement( tag );
		Object.keys( attrs || {} ).forEach( function ( key ) {
			if ( key === 'text' ) {
				node.textContent = attrs[ key ];
			} else if ( key === 'html' ) {
				node.innerHTML = attrs[ key ];
			} else if ( key.indexOf( 'on' ) === 0 ) {
				node.addEventListener( key.slice( 2 ).toLowerCase(), attrs[ key ] );
			} else {
				node.setAttribute( key, attrs[ key ] );
			}
		} );
		( children || [] ).forEach( function ( child ) {
			if ( child ) {
				node.appendChild( child );
			}
		} );
		return node;
	}

	/**
	 * A real month-grid calendar (weekday header, prev/next navigation, every
	 * day rendered as its own cell — available ones clickable, unavailable
	 * ones greyed out) with the time list for the selected day shown
	 * alongside it, replacing what used to be two separate steps (a flat
	 * list of the next 14 available days, then a flat list of times for
	 * whichever one was picked). Shared between the new-booking wizard and
	 * the reschedule flow so both look and behave the same way.
	 *
	 * Dates are always parsed/built as UTC-midnight, even though they
	 * represent a calendar day in the business's own timezone (never a
	 * specific instant) — the day-of-week a date falls under only needs to
	 * be consistent across every cell in the grid, and using the browser's
	 * local-timezone Date parsing on a bare "YYYY-MM-DD" string can shift
	 * that by a day depending on the visitor's own timezone.
	 */
	function renderCalendarPicker( container, options ) {
		var serviceId = options.serviceId;
		var resourceId = options.resourceId || 0;
		var addonIds = options.addonIds || [];
		var timezone = options.timezone || '';
		var serviceLabel = options.serviceLabel || '';
		var resourceLabel = options.resourceLabel || t.anyAvailable;
		var onSelect = options.onSelect;

		var now = new Date();
		var todayUtc = new Date( Date.UTC( now.getFullYear(), now.getMonth(), now.getDate() ) );
		var viewYear = now.getFullYear();
		var viewMonth = now.getMonth() + 1; // 1-12
		var selectedDate = null;
		var selectedDateLabel = '';
		var selectedTime = null;
		var selectedTimeLabel = '';
		var monthCache = {};

		var columns = el( 'div', { class: 'getbooqin-calendar-picker__columns' } );
		var leftCol = el( 'div', { class: 'getbooqin-calendar-picker__left' } );
		var rightCol = el( 'div', { class: 'getbooqin-calendar-picker__right' } );
		columns.appendChild( leftCol );
		columns.appendChild( rightCol );
		container.appendChild( columns );

		var calendarEl = el( 'div', { class: 'getbooqin-calendar' } );
		leftCol.appendChild( calendarEl );

		if ( timezone ) {
			leftCol.appendChild( el( 'p', { class: 'getbooqin-calendar__timezone', text: '🌐 ' + t.timezoneLabel + ': ' + timezone } ) );
		}

		var metaEl = el( 'div', { class: 'getbooqin-calendar__meta' } );
		if ( serviceLabel ) {
			metaEl.appendChild( el( 'div', { class: 'getbooqin-calendar__meta-row' }, [
				el( 'span', { class: 'getbooqin-calendar__meta-label', text: t.serviceLabel } ),
				el( 'span', { class: 'getbooqin-calendar__meta-value', text: serviceLabel } )
			] ) );
		}
		metaEl.appendChild( el( 'div', { class: 'getbooqin-calendar__meta-row' }, [
			el( 'span', { class: 'getbooqin-calendar__meta-label', text: t.teamMemberLabel } ),
			el( 'span', { class: 'getbooqin-calendar__meta-value', text: resourceLabel } )
		] ) );
		leftCol.appendChild( metaEl );

		var submitBtn = el( 'button', { type: 'button', class: 'getbooqin-btn getbooqin-calendar__submit', text: t.bookNow } );
		submitBtn.disabled = true;
		submitBtn.addEventListener( 'click', function () {
			if ( selectedDate && selectedTime ) {
				onSelect( selectedDate, selectedDateLabel, selectedTime, selectedTimeLabel );
			}
		} );
		// Appended after `columns` (not into leftCol) so it comes after the
		// time list in DOM order everywhere — on the stacked mobile layout
		// that puts the action last, after the thing that enables it,
		// instead of a disabled button sitting above the time list it's
		// waiting on. On desktop's two-column layout it renders as a
		// full-width row spanning both columns.
		container.appendChild( submitBtn );

		var timesEl = el( 'div', { class: 'getbooqin-calendar-times' } );
		rightCol.appendChild( timesEl );

		function pad2( n ) {
			return n < 10 ? '0' + n : String( n );
		}

		function fetchMonth( y, m ) {
			var key = y + '-' + m;
			if ( monthCache[ key ] ) {
				return Promise.resolve( monthCache[ key ] );
			}
			return daysFor( serviceId, resourceId, y, m, addonIds ).then( function ( map ) {
				monthCache[ key ] = map;
				return map;
			} );
		}

		function renderTimesPrompt() {
			timesEl.innerHTML = '';
			timesEl.appendChild( el( 'h4', { text: t.selectTimeSlot } ) );
			timesEl.appendChild( el( 'p', { class: 'getbooqin-muted', text: t.pickDatePrompt } ) );
		}

		function renderTimesFor( dateStr, dateLabel ) {
			selectedTime = null;
			selectedTimeLabel = '';
			submitBtn.disabled = true;

			timesEl.innerHTML = '';
			timesEl.appendChild( el( 'h4', { text: t.selectTimeSlot } ) );
			var loadingEl = el( 'p', { class: 'getbooqin-muted', text: t.loading } );
			timesEl.appendChild( loadingEl );

			api( 'slots?service_id=' + serviceId + '&resource_id=' + resourceId + '&date=' + dateStr + '&addon_ids=' + addonIds.join( ',' ) )
				.then( function ( slots ) {
					loadingEl.remove();
					if ( ! slots.length ) {
						timesEl.appendChild( el( 'p', { class: 'getbooqin-muted', text: t.noSlots } ) );
						return;
					}
					var list = el( 'div', { class: 'getbooqin-calendar__time-list' } );
					var buttons = [];
					var hint = el( 'p', { class: 'getbooqin-muted getbooqin-calendar__hint', text: t.selectTimeHint } );
					slots.forEach( function ( slot ) {
						var slotBtn = el( 'button', {
							type: 'button',
							class: 'getbooqin-calendar__time',
							text: slot.label,
							'aria-pressed': 'false',
							onClick: function () {
								selectedTime = slot.time;
								selectedTimeLabel = slot.label;
								submitBtn.disabled = false;
								buttons.forEach( function ( b ) {
									b.classList.remove( 'is-selected' );
									b.setAttribute( 'aria-pressed', 'false' );
								} );
								slotBtn.classList.add( 'is-selected' );
								slotBtn.setAttribute( 'aria-pressed', 'true' );
								// The hint's job is done once a slot is picked —
								// left as "Please select a time slot" it reads
								// as an unresolved error on an otherwise-ready
								// form, so it becomes the confirmation instead.
								hint.textContent = slot.label + ' selected.';
								hint.classList.add( 'is-confirmed' );
							}
						} );
						buttons.push( slotBtn );
						list.appendChild( slotBtn );
					} );
					timesEl.appendChild( list );
					timesEl.appendChild( hint );
				} )
				.catch( function ( err ) {
					loadingEl.remove();
					timesEl.appendChild( el( 'p', { class: 'getbooqin-error', role: 'alert', text: err.message } ) );
				} );
		}

		function renderMonth() {
			calendarEl.innerHTML = '';
			var monthStart = new Date( Date.UTC( viewYear, viewMonth - 1, 1 ) );
			var monthLabel = monthStart.toLocaleDateString( undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' } );

			var prevBtn = el( 'button', { type: 'button', class: 'getbooqin-calendar__nav', 'aria-label': 'Previous month', html: '&lsaquo;' } );
			var nextBtn = el( 'button', { type: 'button', class: 'getbooqin-calendar__nav', 'aria-label': 'Next month', html: '&rsaquo;' } );
			var isCurrentMonth = viewYear === todayUtc.getUTCFullYear() && viewMonth === todayUtc.getUTCMonth() + 1;
			if ( isCurrentMonth ) {
				prevBtn.disabled = true;
			}
			prevBtn.addEventListener( 'click', function () {
				viewMonth -= 1;
				if ( viewMonth < 1 ) { viewMonth = 12; viewYear -= 1; }
				renderMonth();
			} );
			nextBtn.addEventListener( 'click', function () {
				viewMonth += 1;
				if ( viewMonth > 12 ) { viewMonth = 1; viewYear += 1; }
				renderMonth();
			} );

			calendarEl.appendChild( el( 'div', { class: 'getbooqin-calendar__header' }, [
				prevBtn,
				el( 'strong', { class: 'getbooqin-calendar__label', text: monthLabel } ),
				nextBtn
			] ) );

			var weekdayLabels = [ 'S', 'M', 'T', 'W', 'T', 'F', 'S' ];
			var weekdaysRow = el( 'div', { class: 'getbooqin-calendar__weekdays' } );
			weekdayLabels.forEach( function ( w ) { weekdaysRow.appendChild( el( 'span', { text: w } ) ); } );
			calendarEl.appendChild( weekdaysRow );

			var grid = el( 'div', { class: 'getbooqin-calendar__grid' } );
			grid.appendChild( el( 'p', { class: 'getbooqin-muted', text: t.loading } ) );
			calendarEl.appendChild( grid );

			fetchMonth( viewYear, viewMonth ).then( function ( map ) {
				grid.innerHTML = '';
				var leadingOffset = monthStart.getUTCDay(); // 0 = Sunday
				for ( var i = 0; i < leadingOffset; i++ ) {
					grid.appendChild( el( 'span', { class: 'getbooqin-calendar__cell getbooqin-calendar__cell--empty' } ) );
				}

				var daysInThisMonth = new Date( Date.UTC( viewYear, viewMonth, 0 ) ).getUTCDate();
				for ( var d = 1; d <= daysInThisMonth; d++ ) {
					var dateStr = viewYear + '-' + pad2( viewMonth ) + '-' + pad2( d );
					var cellDate = new Date( Date.UTC( viewYear, viewMonth - 1, d ) );
					var isPast = cellDate < todayUtc;
					var available = ! isPast && ( map[ dateStr ] || 0 ) > 0;

					var classes = 'getbooqin-calendar__cell getbooqin-calendar__day';
					if ( ! available ) classes += ' is-unavailable';
					if ( selectedDate === dateStr ) classes += ' is-selected';

					var fullLabel = cellDate.toLocaleDateString( undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' } );
					// aria-pressed, not aria-current: aria-current="date" means
					// "today", not "the selected day" — using it for selection
					// would misreport which day is actually today to screen readers.
					var cellAttrs = { type: 'button', class: classes, text: String( d ), 'aria-label': fullLabel, 'aria-pressed': selectedDate === dateStr ? 'true' : 'false' };
					var cellButton = el( 'button', cellAttrs );
					if ( ! available ) {
						cellButton.disabled = true;
					} else {
						( function ( dateStr, dateLabel ) {
							cellButton.addEventListener( 'click', function () {
								selectedDate = dateStr;
								selectedDateLabel = dateLabel;
								renderMonth();
								renderTimesFor( dateStr, dateLabel );
							} );
						} )( dateStr, cellDate.toLocaleDateString( undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' } ) );
					}
					grid.appendChild( cellButton );
				}
			} ).catch( function ( err ) {
				grid.innerHTML = '';
				grid.appendChild( el( 'p', { class: 'getbooqin-error', role: 'alert', text: err.message } ) );
			} );
		}

		renderMonth();
		renderTimesPrompt();
	}

	function Wizard( root ) {
		this.root = root;
		this.body = root.querySelector( '.getbooqin-booking__body' );
		this.steps = root.querySelectorAll( '.getbooqin-booking__steps span' );
		this.cfg = null;
		this.state = {
			step: 0,
			serviceId: parseInt( root.dataset.serviceId, 10 ) || 0,
			resourceId: parseInt( root.dataset.resourceId, 10 ) || 0,
			serviceName: '',
			resourceName: '',
			addonIds: [],
			addonsLabel: '',
			date: '',
			dateLabel: '',
			time: '',
			timeLabel: ''
		};

		var preselected = new URLSearchParams( window.location.search ).get( 'service' );
		if ( ! this.state.serviceId && preselected ) {
			this.state.serviceId = parseInt( preselected, 10 ) || 0;
		}

		// Resources/add-ons/days are cached by key at module scope (see
		// resourcesFor/addonsFor/daysFor above), usually already prefetched
		// by prefetchBooking() well before this modal ever opened — the
		// wizard's own steps just ask for the same keys and get whatever's
		// there, in flight or not.
		if ( this.state.serviceId ) {
			prefetchBooking( this.state.serviceId );
		}

		var self = this;
		this.loading();
		config().then( function ( cfg ) {
			self.cfg = cfg;
			self.start();
		} ).catch( function ( err ) {
			self.body.innerHTML = '';
			self.error( err.message );
		} );
	}

	Wizard.prototype.setProgress = function ( index ) {
		Array.prototype.forEach.call( this.steps, function ( node, i ) {
			node.classList.toggle( 'is-active', i <= index );
		} );
	};

	Wizard.prototype.loading = function () {
		this.body.innerHTML = '';
		this.body.appendChild( el( 'p', { class: 'getbooqin-muted', text: t.loading } ) );
	};

	Wizard.prototype.error = function ( message ) {
		var existing = this.body.querySelector( '.getbooqin-error' );
		if ( existing ) {
			existing.remove();
		}
		var errorEl = el( 'p', { class: 'getbooqin-error', id: 'getbooqin-error', role: 'alert', text: message } );
		// A step's actions row (Confirm/Back) sits at the very end of body —
		// appending the error after it put the message below the buttons,
		// clipped by the modal's bottom edge on a step that scrolls. Insert
		// it before that row instead, so it's visible without scrolling
		// further than the buttons already required.
		var actions = this.body.querySelector( '.getbooqin-actions' );
		if ( actions ) {
			actions.parentNode.insertBefore( errorEl, actions );
		} else {
			this.body.appendChild( errorEl );
		}
	};

	Wizard.prototype.summary = function () {
		var bits = [];
		if ( this.state.serviceName ) {
			bits.push( this.state.serviceName );
		}
		if ( this.state.resourceName ) {
			bits.push( this.state.resourceName );
		}
		if ( this.state.addonsLabel ) {
			bits.push( this.state.addonsLabel );
		}
		if ( this.state.dateLabel ) {
			bits.push( this.state.dateLabel + ( this.state.timeLabel ? ' · ' + this.state.timeLabel : '' ) );
		}
		if ( ! bits.length ) {
			return null;
		}
		return el( 'div', { class: 'getbooqin-summary', text: bits.join( ' — ' ) } );
	};

	Wizard.prototype.start = function () {
		if ( this.state.serviceId ) {
			this.stepResource();
		} else {
			this.stepService();
		}
	};

	Wizard.prototype.stepService = function () {
		var self = this;
		this.setProgress( 0 );
		this.loading();

		api( 'services' ).then( function ( services ) {
			self.body.innerHTML = '';
			var heading = el( 'h4', { text: t.chooseService } );
			self.body.appendChild( heading );
			focusHeading( heading );

			if ( ! services.length ) {
				self.body.appendChild( el( 'p', { class: 'getbooqin-muted', text: t.noSlots } ) );
				return;
			}

			var list = el( 'div', { class: 'getbooqin-options' } );
			services.forEach( function ( service ) {
				var meta = service.duration + ' ' + t.min;
				if ( service.price > 0 ) {
					meta += ' · ' + service.price_html;
				}
				list.appendChild(
					el( 'button', {
						type: 'button',
						class: 'getbooqin-option',
						onClick: function () {
							self.state.serviceId = service.id;
							self.state.serviceName = service.name;
							self.stepResource();
						}
					}, [
						el( 'strong', { text: service.name } ),
						el( 'small', { text: meta } )
					] )
				);
			} );
			self.body.appendChild( list );
		} ).catch( function ( err ) {
			self.body.innerHTML = '';
			self.error( err.message );
		} );
	};

	Wizard.prototype.stepResource = function () {
		var self = this;
		this.setProgress( 1 );
		// No this.loading() here: when there's only one resource (the common
		// case), this step auto-advances without showing anything, so
		// re-painting "Loading…" over itself just flashes the modal for no
		// reason. The constructor's initial loading() call is still on
		// screen and stays there until there's real content to show —
		// either the resource list below, or whatever the next step renders.

		if ( this.state.resourceId ) {
			this.stepAddons();
			return;
		}

		resourcesFor( this.state.serviceId ).then( function ( resources ) {
			if ( resources.length <= 1 ) {
				self.state.resourceId = resources.length ? resources[ 0 ].id : 0;
				self.state.resourceName = resources.length ? resources[ 0 ].name : '';
				self.stepAddons();
				return;
			}

			self.body.innerHTML = '';
			var summary = self.summary();
			if ( summary ) {
				self.body.appendChild( summary );
			}
			var heading = el( 'h4', { text: t.chooseStaff } );
			self.body.appendChild( heading );
			focusHeading( heading );

			var list = el( 'div', { class: 'getbooqin-options' } );

			list.appendChild(
				el( 'button', {
					type: 'button',
					class: 'getbooqin-option',
					onClick: function () {
						self.state.resourceId = 0;
						self.state.resourceName = '';
						self.stepAddons();
					}
				}, [ el( 'strong', { text: t.anyAvailable } ) ] )
			);

			resources.forEach( function ( resource ) {
				list.appendChild(
					el( 'button', {
						type: 'button',
						class: 'getbooqin-option',
						onClick: function () {
							self.state.resourceId = resource.id;
							self.state.resourceName = resource.name;
							self.stepAddons();
						}
					}, [
						el( 'strong', { text: resource.name } ),
						resource.title ? el( 'small', { text: resource.title } ) : null
					] )
				);
			} );

			self.body.appendChild( list );
			self.body.appendChild( self.backRow( function () {
				self.state.serviceId = 0;
				self.stepService();
			} ) );
		} ).catch( function ( err ) {
			self.body.innerHTML = '';
			self.error( err.message );
		} );
	};

	Wizard.prototype.stepAddons = function () {
		var self = this;
		this.setProgress( 1 );
		// Same reasoning as stepResource: most services have no add-ons, so
		// this step usually auto-advances straight into stepDateTime with
		// nothing to show — don't flash a redundant loading state for that.

		addonsFor( this.state.serviceId ).then( function ( addons ) {
			if ( ! addons.length ) {
				self.stepDateTime();
				return;
			}

			self.body.innerHTML = '';
			var summary = self.summary();
			if ( summary ) {
				self.body.appendChild( summary );
			}
			var heading = el( 'h4', { text: t.chooseAddons } );
			self.body.appendChild( heading );
			focusHeading( heading );

			var checkboxes = [];
			var list = el( 'div', { class: 'getbooqin-options getbooqin-addons' } );
			addons.forEach( function ( addon ) {
				var checkbox = el( 'input', { type: 'checkbox', id: 'getbooqin-addon-' + addon.id, value: String( addon.id ) } );
				checkboxes.push( checkbox );

				var meta = addon.price_html;
				if ( addon.duration_min > 0 ) {
					meta += ' · +' + addon.duration_min + ' ' + t.min;
				}

				list.appendChild(
					el( 'label', { class: 'getbooqin-addon', for: 'getbooqin-addon-' + addon.id }, [
						checkbox,
						el( 'span', {}, [
							el( 'strong', { text: addon.name } ),
							el( 'small', { text: meta } )
						] )
					] )
				);
			} );
			self.body.appendChild( list );

			var continueBtn = el( 'button', { type: 'button', class: 'getbooqin-btn', text: t.continueLabel } );
			continueBtn.addEventListener( 'click', function () {
				var selected = checkboxes.filter( function ( cb ) { return cb.checked; } );
				self.state.addonIds = selected.map( function ( cb ) { return parseInt( cb.value, 10 ); } );
				self.state.addonsLabel = selected.length ? selected.length + ' add-on' + ( selected.length > 1 ? 's' : '' ) : '';
				self.stepDateTime();
			} );
			self.body.appendChild( el( 'div', { class: 'getbooqin-actions' }, [ continueBtn ] ) );

			self.body.appendChild( self.backRow( function () {
				self.state.resourceId = 0;
				self.stepResource();
			} ) );
		} ).catch( function ( err ) {
			self.body.innerHTML = '';
			self.error( err.message );
		} );
	};

	Wizard.prototype.stepDateTime = function () {
		var self = this;
		this.setProgress( 2 );
		this.body.innerHTML = '';
		// No summary bar here — Service/Team Member are shown inline in the
		// picker's own meta rows now, so repeating them above would just be
		// duplicate real estate. Other steps still show it since they don't
		// otherwise surface that context.
		var dateHeading = el( 'h4', { text: t.chooseDate } );
		this.body.appendChild( dateHeading );
		focusHeading( dateHeading );

		var pickerContainer = el( 'div', { class: 'getbooqin-calendar-picker' } );
		this.body.appendChild( pickerContainer );

		renderCalendarPicker( pickerContainer, {
			serviceId: this.state.serviceId,
			resourceId: this.state.resourceId,
			addonIds: this.state.addonIds,
			timezone: this.cfg && this.cfg.timezone,
			serviceLabel: this.state.serviceName,
			resourceLabel: this.state.resourceName,
			onSelect: function ( date, dateLabel, time, timeLabel ) {
				self.state.date = date;
				self.state.dateLabel = dateLabel;
				self.state.time = time;
				self.state.timeLabel = timeLabel;
				self.stepDetails();
			}
		} );

		this.body.appendChild( this.backRow( function () {
			self.stepAddons();
		} ) );
	};

	Wizard.prototype.stepDetails = function () {
		var self = this;
		this.setProgress( 3 );
		this.body.innerHTML = '';
		this.body.appendChild( this.summary() );
		var detailsHeading = el( 'h4', { text: t.yourDetails } );
		this.body.appendChild( detailsHeading );
		focusHeading( detailsHeading );

		function field( name, label, type, required ) {
			var fieldInput = el( 'input', { type: type, name: name, id: 'getbooqin-' + name } );
			if ( required ) {
				fieldInput.setAttribute( 'required', 'required' );
			}
			return el( 'div', { class: 'getbooqin-field' }, [
				el( 'label', { for: 'getbooqin-' + name, text: label + ( required ? ' *' : '' ) } ),
				fieldInput
			] );
		}

		var requirePhone = !! ( self.cfg && self.cfg.settings && self.cfg.settings.requirePhone );
		var consentText = self.cfg && self.cfg.settings ? self.cfg.settings.consentText : '';
		var intakeFields = ( self.cfg && self.cfg.settings && self.cfg.settings.intakeFields ) || [];

		function intakeInput( def ) {
			var inputEl;
			if ( def.type === 'textarea' ) {
				inputEl = el( 'textarea', { name: 'cf_' + def.key, id: 'getbooqin-cf-' + def.key, rows: '3' } );
			} else {
				var htmlType = def.type === 'phone' ? 'tel' : ( def.type === 'email' ? 'email' : 'text' );
				inputEl = el( 'input', { type: htmlType, name: 'cf_' + def.key, id: 'getbooqin-cf-' + def.key } );
			}
			if ( def.required ) {
				inputEl.setAttribute( 'required', 'required' );
			}
			return el( 'div', { class: 'getbooqin-field' }, [
				el( 'label', { for: 'getbooqin-cf-' + def.key, text: def.label + ( def.required ? ' *' : '' ) } ),
				inputEl
			] );
		}

		var form = el( 'div' );
		form.appendChild( el( 'div', { class: 'getbooqin-field-row' }, [
			field( 'first_name', t.firstName, 'text', true ),
			field( 'last_name', t.lastName, 'text', false )
		] ) );
		form.appendChild( field( 'email', t.email, 'email', true ) );
		form.appendChild( field( 'phone', t.phone, 'tel', requirePhone ) );

		intakeFields.forEach( function ( def ) {
			form.appendChild( intakeInput( def ) );
		} );

		var notes = el( 'textarea', { name: 'notes', id: 'getbooqin-notes', rows: '3' } );
		form.appendChild( el( 'div', { class: 'getbooqin-field' }, [
			el( 'label', { for: 'getbooqin-notes', text: t.notes } ),
			notes
		] ) );

		// Honeypot. Deliberately not called "website" — autofill volunteers a
		// value for that name, which would silently discard real bookings.
		form.appendChild( el( 'input', {
			type: 'text',
			name: 'os_hp_a1b2',
			class: 'getbooqin-hp',
			tabindex: '-1',
			autocomplete: 'off',
			'aria-hidden': 'true'
		} ) );

		if ( consentText ) {
			form.appendChild( el( 'p', { class: 'getbooqin-muted', text: consentText } ) );
		}

		var submit = el( 'button', { type: 'button', class: 'getbooqin-btn', text: t.confirm } );
		submit.addEventListener( 'click', function () {
			var customFields = {};
			var missingRequired = false;
			intakeFields.forEach( function ( def ) {
				var input = form.querySelector( '[name=cf_' + def.key + ']' );
				var value = input ? input.value.trim() : '';
				customFields[ def.key ] = value;
				if ( def.required && ! value ) {
					missingRequired = true;
				}
			} );

			var payload = {
				service_id: self.state.serviceId,
				resource_id: self.state.resourceId,
				date: self.state.date,
				time: self.state.time,
				first_name: form.querySelector( '[name=first_name]' ).value.trim(),
				last_name: form.querySelector( '[name=last_name]' ).value.trim(),
				email: form.querySelector( '[name=email]' ).value.trim(),
				phone: form.querySelector( '[name=phone]' ).value.trim(),
				notes: notes.value.trim(),
				custom_fields: customFields,
				addon_ids: self.state.addonIds,
				os_hp_a1b2: form.querySelector( '[name=os_hp_a1b2]' ).value
			};

			if ( ! payload.first_name || ! payload.email || missingRequired ) {
				self.error( t.required );
				var invalidFields = form.querySelectorAll( '[required]' );
				for ( var i = 0; i < invalidFields.length; i++ ) {
					if ( ! invalidFields[ i ].value.trim() ) {
						invalidFields[ i ].setAttribute( 'aria-describedby', 'getbooqin-error' );
						invalidFields[ i ].focus();
						break;
					}
				}
				return;
			}

			submit.disabled = true;
			api( 'bookings', { method: 'POST', body: JSON.stringify( payload ) } )
				.then( function ( booking ) {
					if ( booking.payment && booking.payment.required && booking.payment.gateways.length ) {
						self.stepPay( booking );
					} else {
						self.stepDone( booking );
					}
				} )
				.catch( function ( err ) {
					submit.disabled = false;
					self.error( err.message );
				} );
		} );

		form.appendChild( el( 'div', { class: 'getbooqin-actions' }, [
			submit,
			el( 'button', {
				type: 'button',
				class: 'getbooqin-btn getbooqin-btn--ghost',
				text: t.back,
				onClick: function () {
					self.stepDateTime();
				}
			} )
		] ) );

		this.body.appendChild( form );
	};

	/**
	 * Escapes the handful of characters the iCalendar spec (RFC 5545) treats
	 * as special in TEXT values. Nothing here is untrusted HTML — this file
	 * is inserted into a .ics, not the DOM — but commas/semicolons in a
	 * service or customer name would otherwise corrupt the file structure.
	 */
	function icsEscape( value ) {
		return String( value || '' ).replace( /\\/g, '\\\\' ).replace( /[,;]/g, '\\$&' ).replace( /\n/g, '\\n' );
	}

	function icsTimestamp( iso ) {
		// "2026-08-31T11:00:00.000Z" -> "20260831T110000Z"
		return iso.replace( /[-:]/g, '' ).replace( /\.\d{3}/, '' );
	}

	/**
	 * A same-page .ics download for the confirmation screen — the booking
	 * record already has everything needed (start_utc/end_utc are real UTC
	 * instants, so this needs no timezone data of its own to be correct).
	 */
	function icsDataUrl( booking ) {
		if ( ! booking.start_utc || ! booking.end_utc ) {
			return null;
		}
		var summary = booking.service || t.bookNow;
		var descriptionBits = [];
		if ( booking.resource ) {
			descriptionBits.push( t.teamMemberLabel + ': ' + booking.resource );
		}
		if ( booking.manage_url ) {
			descriptionBits.push( 'Manage this booking: ' + booking.manage_url );
		}
		var lines = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//GetBooqin//Booking//EN',
			'BEGIN:VEVENT',
			'UID:' + icsEscape( booking.uid ) + '@getbooqin',
			'DTSTAMP:' + icsTimestamp( new Date().toISOString() ),
			'DTSTART:' + icsTimestamp( booking.start_utc ),
			'DTEND:' + icsTimestamp( booking.end_utc ),
			'SUMMARY:' + icsEscape( summary ),
			'DESCRIPTION:' + icsEscape( descriptionBits.join( '\\n' ) ),
			'END:VEVENT',
			'END:VCALENDAR'
		];
		return 'data:text/calendar;charset=utf-8,' + encodeURIComponent( lines.join( '\r\n' ) );
	}

	/**
	 * Everything a customer needs from this screen without having to find
	 * the confirmation email: what they booked, with whom, for how much,
	 * a reference to quote if they call, a link back to manage it, and a
	 * calendar file. Shared between stepDone (paid/free path) and
	 * stepInstructions (offline-payment path) so neither shortchanges it.
	 */
	function confirmationDetails( booking ) {
		var nodes = [];
		var bits = [];
		if ( booking.service ) bits.push( booking.service );
		if ( booking.resource ) bits.push( t.teamMemberLabel + ': ' + booking.resource );
		if ( booking.date && booking.time ) {
			bits.push( booking.date + ' · ' + booking.time + ( booking.timezone_label ? ' (' + booking.timezone_label + ')' : '' ) );
		}
		if ( booking.price_html ) bits.push( booking.price_html );
		if ( bits.length ) {
			nodes.push( el( 'ul', { class: 'getbooqin-confirmation-details' }, bits.map( function ( bit ) {
				return el( 'li', { text: bit } );
			} ) ) );
		}
		if ( booking.uid ) {
			nodes.push( el( 'p', { class: 'getbooqin-muted', text: 'Reference: ' + booking.uid } ) );
		}

		var actions = [];
		var icsUrl = icsDataUrl( booking );
		if ( icsUrl ) {
			actions.push( el( 'a', { class: 'getbooqin-btn getbooqin-btn--ghost', href: icsUrl, download: 'appointment.ics', text: 'Add to calendar' } ) );
		}
		if ( booking.manage_url ) {
			actions.push( el( 'a', { class: 'getbooqin-btn getbooqin-btn--ghost', href: booking.manage_url, text: 'Manage this booking' } ) );
		}
		if ( actions.length ) {
			nodes.push( el( 'div', { class: 'getbooqin-actions' }, actions ) );
		}
		return nodes;
	}

	/**
	 * Shown after choosing an offline method. The booking is real but unpaid,
	 * so this screen states that plainly instead of thanking them for a
	 * payment that never happened.
	 */
	Wizard.prototype.stepInstructions = function ( booking, message ) {
		this.setProgress( 3 );
		this.body.innerHTML = '';
		this.body.appendChild(
			el( 'div', { class: 'getbooqin-done' }, [
				el( 'div', { class: 'getbooqin-done__mark', text: '✓' } ),
				el( 'h4', { text: t.booked } ),
				message ? el( 'p', { class: 'getbooqin-instructions', text: message } ) : null,
				el( 'p', { class: 'getbooqin-muted', text: t.bookedIntro } ),
				booking.meeting && booking.meeting.is_video
					? el( 'p', { class: 'getbooqin-muted', text: t.videoNote } )
					: null
			].concat( confirmationDetails( booking ) ) )
		);
	};

	Wizard.prototype.stepPay = function ( booking ) {
		var self = this;
		this.setProgress( 3 );
		this.body.innerHTML = '';

		var payHeading = el( 'h4', { text: t.choosePayment } );
		this.body.appendChild( payHeading );
		focusHeading( payHeading );
		this.body.appendChild(
			el( 'p', { class: 'getbooqin-summary', text: t.amountDue + ': ' + booking.payment.due_html } )
		);

		var msg = el( 'div', { class: 'getbooqin-pay__msg', role: 'status' } );
		var methods = el( 'div', { class: 'getbooqin-options' } );

		booking.payment.gateways.forEach( function ( gateway ) {
			methods.appendChild(
				el( 'button', {
					type: 'button',
					class: 'getbooqin-option',
					onClick: function () {
						loadGatewayScript( gateway.id ).then( function () {
							startPayment(
								booking.uid,
								gateway.id,
								msg,
								function () {
									self.stepDone( booking, true );
								},
								function ( message ) {
									self.stepInstructions( booking, message );
								}
							);
						} );
					}
				}, [
					el( 'strong', { text: gateway.label } ),
					gateway.description ? el( 'small', { text: gateway.description } ) : null
				] )
			);
		} );

		this.body.appendChild( methods );
		this.body.appendChild( msg );
		this.body.appendChild(
			el( 'div', { class: 'getbooqin-actions' }, [
				el( 'button', {
					type: 'button',
					class: 'getbooqin-btn getbooqin-btn--ghost',
					text: t.payLater,
					onClick: function () {
						self.stepDone( booking );
					}
				} )
			] )
		);
	};

	var scriptPromises = {};
	function loadGatewayScript( gatewayId ) {
		if ( 'razorpay' !== gatewayId ) {
			return Promise.resolve();
		}
		if ( scriptPromises.razorpay ) {
			return scriptPromises.razorpay;
		}
		scriptPromises.razorpay = new Promise( function ( resolve, reject ) {
			if ( window.Razorpay ) {
				resolve();
				return;
			}
			var script = document.createElement( 'script' );
			script.src = 'https://checkout.razorpay.com/v1/checkout.js';
			script.onload = resolve;
			script.onerror = reject;
			document.head.appendChild( script );
		} );
		return scriptPromises.razorpay;
	}

	/**
	 * Kicks off a payment. Redirect gateways leave the page; Razorpay opens in
	 * place and is verified server-side before we ever say "paid".
	 */
	function startPayment( uid, gatewayId, msg, onPaid, onInstructions ) {
		msg.textContent = t.loading;

		api( 'payments/start', {
			method: 'POST',
			body: JSON.stringify( { uid: uid, gateway: gatewayId } )
		} )
			.then( function ( result ) {
				if ( 'redirect' === result.type ) {
					msg.textContent = t.redirecting;
					window.location.href = result.url;
					return;
				}

				if ( 'instructions' === result.type ) {
					msg.textContent = result.message;
					if ( onInstructions ) {
						onInstructions( result.message );
					}
					return;
				}

				if ( 'razorpay' === result.type ) {
					if ( typeof window.Razorpay === 'undefined' ) {
						msg.textContent = t.genericError;
						return;
					}
					msg.textContent = '';

					var options = Object.assign( {}, result.params, {
						handler: function ( response ) {
							msg.textContent = t.loading;
							api( 'payments/verify', {
								method: 'POST',
								body: JSON.stringify( {
									payment_id: result.payment_id,
									razorpay_order_id: response.razorpay_order_id,
									razorpay_payment_id: response.razorpay_payment_id,
									razorpay_signature: response.razorpay_signature
								} )
							} )
								.then( function () {
									msg.textContent = t.paymentDone;
									if ( onPaid ) {
										onPaid();
									}
								} )
								.catch( function ( err ) {
									msg.textContent = err.message;
								} );
						},
						modal: {
							ondismiss: function () {
								msg.textContent = '';
							}
						}
					} );

					new window.Razorpay( options ).open();
					return;
				}

				msg.textContent = t.genericError;
			} )
			.catch( function ( err ) {
				msg.textContent = err.message;
			} );
	}

	Wizard.prototype.stepDone = function ( booking, paid ) {
		this.setProgress( 3 );
		this.body.innerHTML = '';
		this.body.appendChild(
			el( 'div', { class: 'getbooqin-done' }, [
				el( 'div', { class: 'getbooqin-done__mark', text: '✓' } ),
				el( 'h4', { text: t.booked } ),
				el( 'p', { class: 'getbooqin-muted', text: paid ? t.paymentDone : t.bookedIntro } ),
				booking.meeting && booking.meeting.is_video
					? el( 'p', { class: 'getbooqin-muted', text: t.videoNote } )
					: null
			].concat( confirmationDetails( booking ) ) )
		);
	};

	Wizard.prototype.backRow = function ( handler ) {
		return el( 'div', { class: 'getbooqin-actions' }, [
			el( 'button', { type: 'button', class: 'getbooqin-btn getbooqin-btn--ghost', text: t.back, onClick: handler } )
		] );
	};

	/**
	 * Reuses the same days/slots endpoints the new-booking wizard uses —
	 * just a date step then a time step, since who/what is being booked
	 * isn't changing, only when. Replaces the card's own content while
	 * active rather than opening a modal, so "Back" just re-renders the
	 * card from scratch.
	 */
	function renderRescheduleFlow( card ) {
		var uid = card.dataset.uid;
		var serviceId = card.dataset.serviceId;
		var resourceId = card.dataset.resourceId;
		var serviceName = card.dataset.serviceName;
		var resourceName = card.dataset.resourceName;

		card.innerHTML = '';
		var rescheduleHeading = el( 'h3', { text: t.pickNewDate } );
		card.appendChild( rescheduleHeading );
		focusHeading( rescheduleHeading );
		var pickerContainer = el( 'div', { class: 'getbooqin-calendar-picker' } );
		card.appendChild( pickerContainer );
		card.appendChild( backRowStandalone( function () { renderManageCard( card ); } ) );

		config().then( function ( cfg ) {
			renderCalendarPicker( pickerContainer, {
				serviceId: serviceId,
				resourceId: resourceId,
				timezone: cfg && cfg.timezone,
				serviceLabel: serviceName,
				resourceLabel: resourceName,
				onSelect: function ( date, dateLabel, time ) {
				card.innerHTML = '';
				card.appendChild( el( 'p', { class: 'getbooqin-muted', text: t.loading } ) );
				api( 'bookings/' + uid + '/reschedule', { method: 'POST', body: JSON.stringify( { date: date, time: time } ) } )
					.then( function () {
						renderManageCard( card );
					} )
					.catch( function ( err ) {
						card.innerHTML = '';
						card.appendChild( el( 'p', { class: 'getbooqin-error', role: 'alert', text: err.message } ) );
						card.appendChild( backRowStandalone( function () { renderManageCard( card ); } ) );
					} );
				}
			} );
		} );
	}

	function backRowStandalone( handler ) {
		return el( 'div', { class: 'getbooqin-actions' }, [
			el( 'button', { type: 'button', class: 'getbooqin-btn getbooqin-btn--ghost', text: t.back, onClick: handler } )
		] );
	}

	function wireManageCard( card ) {
		var button = card.querySelector( '[data-getbooqin-cancel]' );
		var rescheduleButton = card.querySelector( '[data-getbooqin-reschedule]' );
		var msg = card.querySelector( '.getbooqin-manage__msg' );
		if ( button ) {
			button.addEventListener( 'click', function () {
				if ( ! window.confirm( t.cancelConfirm ) ) {
					return;
				}
				button.disabled = true;
				api( 'bookings/' + card.dataset.uid + '/cancel', { method: 'POST' } )
					.then( function () {
						button.remove();
						msg.textContent = t.cancelled;
					} )
					.catch( function ( err ) {
						button.disabled = false;
						msg.textContent = err.message;
					} );
			} );
		}
		if ( rescheduleButton ) {
			rescheduleButton.addEventListener( 'click', function () {
				renderRescheduleFlow( card );
			} );
		}
		var payBox = card.querySelector( '.getbooqin-pay' );
		if ( payBox ) {
			initPay( payBox );
		}
	}

	/**
	 * The "manage an existing booking" view. Liquid has no way to call our API
	 * at render time, so — unlike the WordPress version, which rendered this
	 * card server-side in PHP — it is fetched and built here on the client.
	 */
	function renderManageCard( card ) {
		var uid = card.dataset.uid;
		card.innerHTML = '';
		card.appendChild( el( 'p', { class: 'getbooqin-muted', text: t.loading } ) );

		api( 'bookings/' + encodeURIComponent( uid ) )
			.then( function ( b ) {
				card.innerHTML = '';
				var manageHeading = el( 'h3', { text: 'Your booking' } );
				card.appendChild( manageHeading );
				focusHeading( manageHeading );
				card.appendChild( el( 'p', { class: 'getbooqin-status getbooqin-status--' + b.status, text: b.status } ) );

				var dl = el( 'dl', { class: 'getbooqin-details' }, [
					el( 'dt', { text: 'Service' } ), el( 'dd', { text: b.service } ),
					el( 'dt', { text: 'With' } ), el( 'dd', { text: b.resource } ),
					el( 'dt', { text: 'When' } ), el( 'dd', { text: b.date + ' · ' + b.time } )
				] );
				card.appendChild( dl );

				if ( b.meeting && b.meeting.url ) {
					card.appendChild( el( 'p', {}, [
						el( 'a', { class: 'getbooqin-btn', href: b.meeting.url, target: '_blank', rel: 'noopener', text: t.joinCall } )
					] ) );
				}

				if ( b.payment && b.payment.required ) {
					var payBox = el( 'div', { class: 'getbooqin-pay', 'data-uid': b.uid }, [
						el( 'p', {}, [ el( 'strong', { text: t.amountDue + ': ' } ), document.createTextNode( b.payment.due_html ) ] )
					] );
					var methods = el( 'div', { class: 'getbooqin-pay__methods' } );
					b.payment.gateways.forEach( function ( g ) {
						methods.appendChild( el( 'button', { type: 'button', class: 'getbooqin-btn getbooqin-btn--ghost', 'data-getbooqin-pay': g.id, text: g.label } ) );
					} );
					payBox.appendChild( methods );
					payBox.appendChild( el( 'div', { class: 'getbooqin-pay__msg', role: 'status' } ) );
					card.appendChild( payBox );
				} else if ( 'paid' === b.payment.status ) {
					card.appendChild( el( 'p', { class: 'getbooqin-status getbooqin-status--completed', text: 'Paid' } ) );
				}

				var actions = el( 'div', { class: 'getbooqin-actions' } );
				if ( b.can_reschedule ) {
					actions.appendChild( el( 'button', { type: 'button', class: 'getbooqin-btn getbooqin-btn--ghost', text: t.rescheduleBooking, 'data-getbooqin-reschedule': '' } ) );
				}
				if ( b.can_cancel ) {
					actions.appendChild( el( 'button', { type: 'button', class: 'getbooqin-btn getbooqin-btn--danger', text: t.cancelBooking, 'data-getbooqin-cancel': '' } ) );
				}
				if ( actions.children.length ) {
					card.appendChild( actions );
				}
				card.appendChild( el( 'div', { class: 'getbooqin-manage__msg', role: 'status' } ) );
				card.dataset.uid = b.uid;
				card.dataset.serviceId = String( b.service_id || 0 );
				card.dataset.resourceId = String( b.resource_id || 0 );
				card.dataset.serviceName = b.service || '';
				card.dataset.resourceName = b.resource || '';

				wireManageCard( card );
			} )
			.catch( function ( err ) {
				card.innerHTML = '';
				card.appendChild( el( 'p', {}, [ document.createTextNode( err.message ) ] ) );
			} );
	}

	function initPay( box ) {
		var msg = box.querySelector( '.getbooqin-pay__msg' );
		box.querySelectorAll( '[data-getbooqin-pay]' ).forEach( function ( button ) {
			button.addEventListener( 'click', function () {
				loadGatewayScript( button.dataset.getbooqinPay ).then( function () {
					startPayment(
						box.dataset.uid,
						button.dataset.getbooqinPay,
						msg,
						function () {
							window.location.reload();
						},
						function () {
							box.querySelectorAll( '[data-getbooqin-pay]' ).forEach( function ( other ) {
								other.disabled = true;
							} );
						}
					);
				} );
			} );
		} );
	}

	/**
	 * Opens the booking wizard in a centered modal, appended to <body> so it
	 * overlays the whole page regardless of where the launcher button sits
	 * in the DOM. Only one can be open at a time.
	 */
	function openBookingModal( serviceId ) {
		if ( document.querySelector( '.getbooqin-modal-overlay' ) ) {
			return;
		}

		var root = el( 'div', {
			class: 'getbooqin-booking',
			'data-service-id': String( serviceId ),
			'data-resource-id': '0'
		}, [
			el( 'div', { class: 'getbooqin-booking__body', 'aria-live': 'polite' }, [
				el( 'p', { class: 'getbooqin-muted', text: t.loading } )
			] )
		] );

		var closeBtn = el( 'button', { type: 'button', class: 'getbooqin-modal__close', 'aria-label': t.close, html: '&times;' } );
		var modal = el( 'div', { class: 'getbooqin-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.bookNow, tabindex: '-1' }, [ closeBtn, root ] );
		var overlay = el( 'div', { class: 'getbooqin-modal-overlay' }, [ modal ] );
		var previouslyFocused = document.activeElement;

		function close() {
			overlay.remove();
			document.removeEventListener( 'keydown', onKeydown );
			if ( previouslyFocused && previouslyFocused.focus ) {
				previouslyFocused.focus();
			}
		}
		function onKeydown( e ) {
			if ( e.key === 'Escape' ) {
				close();
				return;
			}
			if ( e.key !== 'Tab' ) {
				return;
			}
			// Basic focus trap: wrap Tab/Shift+Tab within the modal so
			// keyboard users can't tab out to the page underneath.
			var focusable = modal.querySelectorAll( 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])' );
			if ( ! focusable.length ) {
				return;
			}
			var first = focusable[ 0 ];
			var last = focusable[ focusable.length - 1 ];
			if ( e.shiftKey && document.activeElement === first ) {
				e.preventDefault();
				last.focus();
			} else if ( ! e.shiftKey && document.activeElement === last ) {
				e.preventDefault();
				first.focus();
			}
		}

		overlay.addEventListener( 'click', function ( e ) {
			if ( e.target === overlay ) {
				close();
			}
		} );
		closeBtn.addEventListener( 'click', close );
		document.addEventListener( 'keydown', onKeydown );

		document.body.appendChild( overlay );
		modal.focus();
		new Wizard( root );
	}

	/**
	 * This app block runs inside the product section, so `product` is in
	 * scope in Liquid and product-book-button.liquid already put the handle
	 * on the container — the URL fallback only matters if a theme somehow
	 * renders this block outside product context.
	 */
	/**
	 * A theme's native buy buttons don't make sense on a product that's
	 * actually booked, not purchased — but whether *this* product is linked
	 * to a service lives in GetBooqin's database, not Shopify, so a theme can't
	 * know that in Liquid without a metafield sync (a write scope this app
	 * deliberately doesn't request). So instead: any theme that wants this
	 * marks its buy-button markup with data-getbooqin-buy-buttons, and once the
	 * lookup below confirms a link, this swaps it for the same explanatory
	 * note server-rendered themes can show immediately. Safe to call more
	 * than once (e.g. both the inline block and the floating embed present
	 * on one page) — it's just setting the same end state each time.
	 */
	function hideBuyButtons() {
		var target = document.querySelector( '[data-getbooqin-buy-buttons]' );
		if ( ! target || target.querySelector( '.getbooqin-service-note' ) ) {
			return;
		}
		target.innerHTML = '';
		target.appendChild( el( 'p', { class: 'getbooqin-service-note', text: 'This is booked by appointment, not purchased directly — choose a time below.' } ) );
	}

	function initProductEmbed( container ) {
		var handle = container.dataset.productHandle;
		if ( ! handle ) {
			var match = window.location.pathname.match( /\/products\/([^/?#]+)/ );
			handle = match ? decodeURIComponent( match[ 1 ] ) : '';
		}
		if ( ! handle ) {
			return;
		}
		productService( handle )
			.then( function ( result ) {
				if ( ! result.service ) {
					return;
				}
				hideBuyButtons();
				// Start loading the calendar data now, while the button is
				// just sitting on the page — by the time a visitor actually
				// notices it and clicks, this has usually already resolved,
				// so the modal opens with the calendar ready instead of
				// making them wait for it after the click.
				prefetchBooking( result.service.id );
				// The inline block and the floating embed are independent
				// merchant toggles — both can be active on the same product
				// page at once. Only one "Book Now" affordance (and one
				// click-to-open path into the wizard) should ever exist on a
				// page, so skip rendering a second launcher if one's already
				// there. Both initProductEmbed calls resolve their fetch as
				// separate microtasks that run one at a time, not
				// interleaved, so this check-then-append is race-free.
				// Button text comes from Settings -> Widget ("Book now button
				// text"), the single app-wide place to customize it — wait for
				// config() so t.bookNow reflects that override rather than
				// racing it (this call reuses the same in-flight request
				// prefetchBooking() above already started, not a new one).
				// If config() itself fails (transient network blip), still add
				// the launcher rather than stranding the page with no buy
				// button (already removed by hideBuyButtons() above) and no
				// book button either — just with the built-in default label
				// instead of the merchant's custom override.
				function addLauncher() {
					if ( document.querySelector( '.getbooqin-product-embed__launcher' ) ) {
						return;
					}
					var launcher = el( 'button', { type: 'button', class: 'getbooqin-btn getbooqin-product-embed__launcher', text: t.bookNow } );
					launcher.addEventListener( 'click', function () {
						openBookingModal( result.service.id );
					} );
					container.appendChild( launcher );
				}
				config().then( addLauncher ).catch( addLauncher );
			} )
			.catch( function ( err ) {
				// product-service.tsx always answers 200 with
				// { service: null } for "nothing linked" — it never throws
				// for that case (handled above, in .then()). So anything
				// that lands here is a real failure: the proxy route 5xx'd,
				// or the request didn't complete at all (err.status === 0).
				// Rendering nothing for that is indistinguishable from "not
				// bookable" and hides an outage — show it instead.
				container.appendChild( el( 'p', { class: 'getbooqin-error', role: 'alert', text: ( err && err.message ) || t.genericError } ) );
			} );
	}

	document.addEventListener( 'DOMContentLoaded', function () {
		document.querySelectorAll( '.getbooqin-pay' ).forEach( initPay );
		document.querySelectorAll( '.getbooqin-booking' ).forEach( function ( root ) {
			new Wizard( root );
		} );
		document.querySelectorAll( '[data-getbooqin-manage]' ).forEach( renderManageCard );
		document.querySelectorAll( '.getbooqin-product-embed' ).forEach( initProductEmbed );

		// The floating-button app embed renders this element on every page
		// once a merchant turns it on in the theme editor, regardless of
		// whether the current page has a linked service. There's no scope
		// to read the theme's app-embed toggle directly, so the admin home
		// page infers "is this on?" from whether this ping has landed
		// recently — see apps.getbooqin.embed-ping.tsx.
		if ( document.querySelector( '.getbooqin-product-embed--floating' ) ) {
			api( 'embed-ping', { method: 'POST' } ).catch( function () {} );
		}
	} );
} )();
