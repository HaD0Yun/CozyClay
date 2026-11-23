// For a test whose numbers are the block figure's: the look is chosen at launch (src/lowvis/studio/figure.js figureOf;
// nothing given is the cube look), so such a test names the block figure as a launch would, unless its runner names a
// look. Import it first, before anything that imports figure.js: the page side reads the launch once, at its import.
process.env.COZYCLAY_FIGURE ??= "block";
