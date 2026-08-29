/** Renders the GetBooqin Services grid block. Ported from Frontend::shortcode_services(). */
( function () {
	'use strict';

	function render( root ) {
		var category = root.dataset.category || '';
		var showPrice = root.dataset.showPrice !== 'false';
		var bookUrl = root.dataset.bookUrl || '';

		fetch( '/apps/getbooqin/services' )
			.then( function ( r ) { return r.json(); } )
			.then( function ( json ) {
				if ( ! json.success ) return;
				var services = json.data;
				if ( category ) {
					services = services.filter( function ( s ) { return s.category === category; } );
				}
				if ( ! services.length ) {
					root.style.display = 'none';
					return;
				}

				services.forEach( function ( service ) {
					var card = document.createElement( 'div' );
					card.className = 'getbooqin-card getbooqin-service';

					var dot = document.createElement( 'span' );
					dot.className = 'getbooqin-service__dot';
					dot.style.background = service.color;
					dot.setAttribute( 'aria-hidden', 'true' );
					card.appendChild( dot );

					var h4 = document.createElement( 'h4' );
					h4.textContent = service.name;
					card.appendChild( h4 );

					if ( service.description ) {
						var desc = document.createElement( 'p' );
						desc.className = 'getbooqin-muted';
						desc.textContent = service.description;
						card.appendChild( desc );
					}

					var meta = document.createElement( 'p' );
					meta.className = 'getbooqin-service__meta';
					meta.textContent = service.duration + ' min' + ( showPrice && service.price > 0 ? ' · ' + service.price_html : '' );
					card.appendChild( meta );

					if ( bookUrl ) {
						var a = document.createElement( 'a' );
						a.className = 'getbooqin-btn';
						var url = new URL( bookUrl, window.location.origin );
						url.searchParams.set( 'service', service.id );
						a.href = url.pathname + url.search;
						a.textContent = 'Book now';
						card.appendChild( a );
					}

					root.appendChild( card );
				} );
			} );
	}

	document.addEventListener( 'DOMContentLoaded', function () {
		document.querySelectorAll( '[data-getbooqin-services]' ).forEach( render );
	} );
} )();
