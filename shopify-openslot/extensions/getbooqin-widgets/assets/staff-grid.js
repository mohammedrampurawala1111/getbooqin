/** Renders the GetBooqin Staff grid block. Ported from Frontend::shortcode_staff(). */
( function () {
	'use strict';

	function render( root ) {
		fetch( '/apps/getbooqin/resources' )
			.then( function ( r ) { return r.json(); } )
			.then( function ( json ) {
				if ( ! json.success || ! json.data.length ) {
					root.style.display = 'none';
					return;
				}

				json.data.forEach( function ( resource ) {
					var card = document.createElement( 'div' );
					card.className = 'getbooqin-card getbooqin-staff';

					if ( resource.avatar ) {
						var img = document.createElement( 'img' );
						img.className = 'getbooqin-staff__avatar';
						img.src = resource.avatar;
						img.alt = resource.name;
						img.width = 64;
						img.height = 64;
						card.appendChild( img );
					}

					var h4 = document.createElement( 'h4' );
					h4.textContent = resource.name;
					card.appendChild( h4 );

					if ( resource.title ) {
						var title = document.createElement( 'p' );
						title.className = 'getbooqin-muted';
						title.textContent = resource.title;
						card.appendChild( title );
					}

					if ( resource.description ) {
						var desc = document.createElement( 'p' );
						desc.textContent = resource.description;
						card.appendChild( desc );
					}

					root.appendChild( card );
				} );
			} );
	}

	document.addEventListener( 'DOMContentLoaded', function () {
		document.querySelectorAll( '[data-getbooqin-staff]' ).forEach( render );
	} );
} )();
