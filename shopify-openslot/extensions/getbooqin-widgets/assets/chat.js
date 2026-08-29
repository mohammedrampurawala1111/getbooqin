/**
 * GetBooqin chat widget for Shopify.
 *
 * The widget is a thin renderer: every decision about what to say next lives
 * on the server in ChatFlow, so the conversation survives a page reload and
 * cannot be tampered with from the console. Requests go to `/apps/getbooqin/*`,
 * relative to the current storefront page, which Shopify's App Proxy
 * transparently forwards to the app — signed, no nonce needed.
 */
( function () {
	'use strict';

	var API_BASE = '/apps/getbooqin/';
	var STORAGE_KEY = 'getbooqin_conversation';
	var t = { send: 'Send', genericError: 'Something went wrong. Please try again.' };

	function api( path, body ) {
		return fetch( API_BASE + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( body || {} )
		} ).then( function ( response ) {
			return response.json().then( function ( json ) {
				if ( ! response.ok || false === json.success ) {
					throw new Error( ( json && json.message ) || t.genericError );
				}
				return json.data;
			} );
		} );
	}

	function get( path ) {
		return fetch( API_BASE + path ).then( function ( response ) {
			return response.json().then( function ( json ) {
				if ( ! response.ok || false === json.success ) {
					throw new Error( ( json && json.message ) || t.genericError );
				}
				return json.data;
			} );
		} );
	}

	function Chat( root, cfg ) {
		this.root = root;
		this.cfg = cfg;
		this.conversation = null;
		this.busy = false;
		this.build();
	}

	Chat.prototype.build = function () {
		var self = this;
		var chat = this.cfg.chat || {};

		this.root.classList.add( 'getbooqin-chat--' + ( 'left' === chat.position ? 'left' : 'right' ) );
		this.root.style.setProperty( '--getbooqin-chat-color', chat.color || '#2563eb' );

		this.panel = document.createElement( 'div' );
		this.panel.className = 'getbooqin-chat__panel';
		this.panel.setAttribute( 'role', 'dialog' );
		this.panel.setAttribute( 'aria-label', chat.title || 'Chat' );

		var header = document.createElement( 'div' );
		header.className = 'getbooqin-chat__header';

		var titles = document.createElement( 'div' );
		var h3 = document.createElement( 'h3' );
		h3.textContent = chat.title || 'Chat with us';
		var sub = document.createElement( 'p' );
		sub.textContent = chat.subtitle || '';
		titles.appendChild( h3 );
		titles.appendChild( sub );

		var close = document.createElement( 'button' );
		close.className = 'getbooqin-chat__close';
		close.setAttribute( 'aria-label', 'Close' );
		close.innerHTML = '&times;';
		close.addEventListener( 'click', function () {
			self.toggle( false );
		} );

		header.appendChild( titles );
		header.appendChild( close );

		this.log = document.createElement( 'div' );
		this.log.className = 'getbooqin-chat__log';
		this.log.setAttribute( 'aria-live', 'polite' );

		this.quick = document.createElement( 'div' );
		this.quick.className = 'getbooqin-chat__quick';

		this.form = document.createElement( 'form' );
		this.form.className = 'getbooqin-chat__form';
		this.input = document.createElement( 'input' );
		this.input.type = 'text';
		this.input.placeholder = '…';
		this.input.setAttribute( 'autocomplete', 'off' );
		var send = document.createElement( 'button' );
		send.type = 'submit';
		send.textContent = t.send;
		this.form.appendChild( this.input );
		this.form.appendChild( send );
		this.form.addEventListener( 'submit', function ( event ) {
			event.preventDefault();
			var value = self.input.value.trim();
			if ( ! value || self.busy || ! self.conversation ) {
				return;
			}
			self.input.value = '';
			self.push( 'visitor', value );
			self.send( value );
		} );

		this.panel.appendChild( header );
		this.panel.appendChild( this.log );
		this.panel.appendChild( this.quick );
		this.panel.appendChild( this.form );

		this.launcher = document.createElement( 'button' );
		this.launcher.className = 'getbooqin-chat__launcher';
		this.launcher.type = 'button';
		this.launcher.innerHTML = '<span aria-hidden="true">💬</span>';
		var label = document.createElement( 'span' );
		label.textContent = chat.launcherText || 'Need help?';
		this.launcher.appendChild( label );
		this.launcher.addEventListener( 'click', function () {
			self.toggle( ! self.root.classList.contains( 'is-open' ) );
		} );

		this.root.appendChild( this.panel );
		this.root.appendChild( this.launcher );

		document.addEventListener( 'keydown', function ( event ) {
			if ( 'Escape' === event.key ) {
				self.toggle( false );
			}
		} );
	};

	Chat.prototype.toggle = function ( open ) {
		this.root.classList.toggle( 'is-open', open );
		this.launcher.setAttribute( 'aria-expanded', open ? 'true' : 'false' );
		if ( open && ! this.conversation ) {
			this.begin();
		}
		if ( open ) {
			this.input.focus();
		}
	};

	Chat.prototype.begin = function () {
		var self = this;
		var stored = null;

		try {
			stored = window.sessionStorage.getItem( STORAGE_KEY );
		} catch ( e ) {
			stored = null;
		}

		this.typing( true );

		// Resume before starting: otherwise every widget open loses the thread
		// and leaves an orphan conversation row behind.
		var opening = stored
			? get( 'chat/' + encodeURIComponent( stored ) ).catch( function () {
				try {
					window.sessionStorage.removeItem( STORAGE_KEY );
				} catch ( e ) {}
				return api( 'chat/start', { page_url: window.location.href } );
			} )
			: api( 'chat/start', { page_url: window.location.href } );

		opening
			.then( function ( payload ) {
				self.typing( false );
				self.apply( payload );
			} )
			.catch( function ( err ) {
				self.typing( false );
				self.push( 'bot', err.message );
			} );
	};

	Chat.prototype.send = function ( value ) {
		var self = this;
		if ( this.busy || ! this.conversation ) {
			return;
		}
		this.busy = true;
		this.quick.innerHTML = '';
		this.setBusy( true );
		this.typing( true );

		api( 'chat/message', { conversation: this.conversation, value: value } )
			.then( function ( payload ) {
				self.busy = false;
				self.setBusy( false );
				self.typing( false );
				self.apply( payload );
			} )
			.catch( function ( err ) {
				self.busy = false;
				self.setBusy( false );
				self.typing( false );
				self.push( 'bot', err.message );
			} );
	};

	/** Lock the composer while a turn is in flight, so nothing can be typed and lost. */
	Chat.prototype.setBusy = function ( busy ) {
		this.input.disabled = busy;
		Array.prototype.forEach.call( this.form.querySelectorAll( 'button' ), function ( button ) {
			button.disabled = busy;
		} );
		Array.prototype.forEach.call( this.quick.querySelectorAll( 'button' ), function ( button ) {
			button.disabled = busy;
		} );
	};

	Chat.prototype.apply = function ( payload ) {
		var self = this;
		this.conversation = payload.conversation;
		try {
			window.sessionStorage.setItem( STORAGE_KEY, payload.conversation );
		} catch ( e ) {}

		( payload.messages || [] ).forEach( function ( message ) {
			self.push( message.sender, message.body );
		} );

		this.quick.innerHTML = '';
		( payload.options || [] ).forEach( function ( option ) {
			var button = document.createElement( 'button' );
			button.type = 'button';
			button.textContent = option.label;
			button.addEventListener( 'click', function () {
				if ( self.busy ) {
					return;
				}
				self.push( 'visitor', option.label );
				self.send( option.value );
			} );
			self.quick.appendChild( button );
		} );

		var input = payload.input || { type: 'text', placeholder: '' };
		if ( 'none' === input.type ) {
			this.form.style.display = 'none';
		} else {
			this.form.style.display = 'flex';
			this.setInputMode( input.type );
			this.input.placeholder = input.placeholder || '';
		}
	};

	/**
	 * Swap between a single-line input and a real textarea. The multi-line step
	 * used to be downgraded to a one-line box.
	 */
	Chat.prototype.setInputMode = function ( type ) {
		var wantsArea = 'textarea' === type;
		var isArea = 'TEXTAREA' === this.input.tagName;

		if ( wantsArea === isArea ) {
			if ( ! wantsArea ) {
				this.input.type = type;
			}
			return;
		}

		var self = this;
		var next = document.createElement( wantsArea ? 'textarea' : 'input' );

		if ( wantsArea ) {
			next.rows = 2;
			next.addEventListener( 'keydown', function ( event ) {
				if ( 'Enter' === event.key && ! event.shiftKey ) {
					event.preventDefault();
					if ( typeof self.form.requestSubmit === 'function' ) {
						self.form.requestSubmit();
					} else {
						self.form.dispatchEvent( new Event( 'submit', { cancelable: true } ) );
					}
				}
			} );
		} else {
			next.type = type || 'text';
		}

		next.setAttribute( 'autocomplete', 'off' );
		next.className = this.input.className;
		this.form.replaceChild( next, this.input );
		this.input = next;
	};

	Chat.prototype.push = function ( sender, body ) {
		var node = document.createElement( 'div' );
		node.className = 'getbooqin-msg getbooqin-msg--' + ( 'visitor' === sender ? 'visitor' : 'bot' );
		node.textContent = body;
		this.log.appendChild( node );
		this.log.scrollTop = this.log.scrollHeight;
	};

	Chat.prototype.typing = function ( on ) {
		if ( on ) {
			if ( this.typingNode ) {
				return;
			}
			this.typingNode = document.createElement( 'div' );
			this.typingNode.className = 'getbooqin-chat__typing';
			this.typingNode.textContent = '…';
			this.log.appendChild( this.typingNode );
			this.log.scrollTop = this.log.scrollHeight;
		} else if ( this.typingNode ) {
			this.typingNode.remove();
			this.typingNode = null;
		}
	};

	document.addEventListener( 'DOMContentLoaded', function () {
		var root = document.getElementById( 'getbooqin-chat' );
		if ( ! root ) {
			return;
		}
		fetch( API_BASE + 'config' )
			.then( function ( r ) { return r.json(); } )
			.then( function ( json ) {
				if ( ! json.success || ! json.data.chat || ! json.data.chat.enabled ) {
					return;
				}
				new Chat( root, json.data );
			} );
	} );
} )();
