( function () {
	'use strict';

	/* --------------------------------------------------------- Mobile nav */

	function initMobileNav() {
		var toggle = document.querySelector( '[data-menu-toggle]' );
		var nav = document.querySelector( '[data-mobile-nav]' );
		if ( ! toggle || ! nav ) {
			return;
		}
		toggle.addEventListener( 'click', function () {
			var isOpen = toggle.getAttribute( 'aria-expanded' ) === 'true';
			toggle.setAttribute( 'aria-expanded', String( ! isOpen ) );
			nav.hidden = isOpen;
		} );
	}

	/* --------------------------------------------------- Product thumbnails */

	function initProductThumbs() {
		document.querySelectorAll( '[data-thumb]' ).forEach( function ( thumb ) {
			thumb.addEventListener( 'click', function () {
				var target = document.getElementById( thumb.dataset.target );
				if ( target ) {
					target.src = thumb.dataset.full;
				}
				var group = thumb.closest( '.product-page__thumbs' );
				if ( group ) {
					group.querySelectorAll( '.product-page__thumb' ).forEach( function ( t ) {
						t.classList.toggle( 'is-active', t === thumb );
					} );
				}
			} );
		} );
	}

	/* ------------------------------------------------------- Variant picker */

	function initVariantPickers() {
		document.querySelectorAll( '[data-product-section]' ).forEach( function ( section ) {
			var form = section.querySelector( '[data-product-form]' );
			if ( ! form ) {
				return;
			}
			var productId = form.dataset.productId;
			var script = document.querySelector( '[data-product-variants="' + productId + '"]' );
			var variants = [];
			try {
				variants = script ? JSON.parse( script.textContent ) : [];
			} catch ( e ) {
				variants = [];
			}

			var selects = Array.prototype.slice.call( section.querySelectorAll( '[data-variant-option]' ) );
			var variantIdInput = form.querySelector( '[data-variant-id]' );
			var addButton = form.querySelector( '[data-add-to-cart]' );
			var addButtonText = form.querySelector( '[data-add-to-cart-text]' );
			var priceEl = section.querySelector( '.price' );

			if ( ! selects.length || ! variants.length ) {
				return;
			}

			function currentSelection() {
				return selects
					.sort( function ( a, b ) { return Number( a.dataset.optionIndex ) - Number( b.dataset.optionIndex ); } )
					.map( function ( select ) { return select.value; } );
			}

			function findVariant() {
				var selection = currentSelection();
				return variants.find( function ( variant ) {
					return variant.options.every( function ( option, index ) {
						return option === selection[ index ];
					} );
				} );
			}

			function money( cents ) {
				return ( cents / 100 ).toLocaleString( undefined, { style: 'currency', currency: window.Shopify && window.Shopify.currency ? window.Shopify.currency.active : 'USD' } );
			}

			function update() {
				var variant = findVariant();
				if ( ! variant ) {
					if ( addButton ) addButton.disabled = true;
					return;
				}
				if ( variantIdInput ) {
					variantIdInput.value = variant.id;
				}
				if ( priceEl ) {
					var current = priceEl.querySelector( '.price__current' );
					if ( current ) {
						current.textContent = money( variant.price );
					}
				}
				if ( addButton ) {
					addButton.disabled = ! variant.available;
				}
				if ( addButtonText ) {
					addButtonText.textContent = variant.available ? 'Add to cart' : 'Sold out';
				}
			}

			selects.forEach( function ( select ) {
				select.addEventListener( 'change', update );
			} );
		} );
	}

	/* ------------------------------------------------------- Add to cart */

	function updateCartCount( count ) {
		document.querySelectorAll( '[data-cart-count]' ).forEach( function ( el ) {
			el.textContent = String( count );
			el.hidden = count === 0;
		} );
	}

	function showFormMessage( form, message, isError ) {
		var el = form.querySelector( '[data-cart-message]' );
		if ( ! el ) {
			return;
		}
		el.textContent = message;
		el.hidden = false;
		el.dataset.state = isError ? 'error' : 'ok';
	}

	function initAddToCart() {
		document.querySelectorAll( '[data-product-form]' ).forEach( function ( form ) {
			form.addEventListener( 'submit', function ( event ) {
				event.preventDefault();
				var button = form.querySelector( '[data-add-to-cart]' );
				var originalDisabled = button ? button.disabled : false;
				if ( button ) button.disabled = true;

				fetch( '/cart/add.js', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
					body: JSON.stringify( {
						id: form.querySelector( '[data-variant-id]' ).value,
						quantity: form.querySelector( '[name="quantity"]' ).value || 1
					} )
				} )
					.then( function ( response ) {
						return response.json().then( function ( data ) {
							if ( ! response.ok ) {
								throw new Error( data.description || 'Could not add that to your cart.' );
							}
							return data;
						} );
					} )
					.then( function () {
						return fetch( '/cart.js' ).then( function ( r ) { return r.json(); } );
					} )
					.then( function ( cart ) {
						updateCartCount( cart.item_count );
						showFormMessage( form, 'Added to cart.', false );
					} )
					.catch( function ( err ) {
						showFormMessage( form, err.message, true );
					} )
					.finally( function () {
						if ( button ) button.disabled = originalDisabled;
					} );
			} );
		} );
	}

	/* ------------------------------------------------------------- Cart page */

	function initCartPage() {
		var form = document.querySelector( '[data-cart-form]' );
		if ( ! form ) {
			return;
		}

		form.querySelectorAll( '[data-cart-qty]' ).forEach( function ( input ) {
			input.addEventListener( 'change', function () {
				fetch( '/cart/change.js', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify( { line: Number( input.dataset.cartQty ) + 1, quantity: Number( input.value ) } )
				} ).then( function () {
					window.location.reload();
				} );
			} );
		} );

		form.querySelectorAll( '[data-cart-remove]' ).forEach( function ( button ) {
			button.addEventListener( 'click', function () {
				fetch( '/cart/change.js', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify( { line: Number( button.dataset.cartRemove ) + 1, quantity: 0 } )
				} ).then( function () {
					window.location.reload();
				} );
			} );
		} );
	}

	document.addEventListener( 'DOMContentLoaded', function () {
		initMobileNav();
		initProductThumbs();
		initVariantPickers();
		initAddToCart();
		initCartPage();
	} );
} )();
