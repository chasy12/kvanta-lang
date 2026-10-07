/**
 * example-program.js
 *
 * The program shown on a first visit.
 */

export const EXAMPLE_PROGRAM = `func mouse(int x, int y) {
    rectangle(x, y, x + 100, y + 100);
}

func keyboard(int key) {
    if (key == Key::Space) {
        setFigureColor(Color::Blue);
    } else if (key == Key::A) {
        setFigureColor(Color::Green);
    } else {
        setFigureColor(Color::Yellow);
    }
    rectangle(0, 0, 100, 100);
}

func main() {
    setFigureColor(Color::Red);
    setLineColor(Color::Green);
    for i in (0..10000) {
        circle(320, 240, i % 100);
    }
    rectangle(0, 0, 100, 100);
}
`;
