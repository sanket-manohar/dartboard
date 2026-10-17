import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('taps', (tester) async {
    await tester.pumpWidget(ElevatedButton(onPressed: () {}, child: const Text('Go')));
    await tester.tap(find.text('Go'));
    expect(find.text('Done'), findsOneWidget);
  });
  testWidgets('waits', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Text('x')));
    tester.pump();
    await Future.delayed(const Duration(seconds: 1));
    expect(find.text('x'), findsOneWidget);
  });
  test('nothing', () {
    final x = 1 + 1;
  });
  testWidgets('good', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Text('x')));
    await tester.tap(find.text('x'));
    await tester.pump();
    expect(find.text('x'), findsOneWidget);
  });
}
