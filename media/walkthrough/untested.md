# Close the gaps

Right-click a file under **Not tested yet** and choose **Create Test File**.

You get `test/<same path>/<name>_test.dart`, already importing your file, with:

- a `group()` per public class,
- a `test()` stub per public method, getter and top-level function,
- a `testWidgets()` "renders" test for widgets.

```dart
group('LoginBloc', () {
  test('login', () {
    // TODO: arrange, act, assert.
  });
});
```

Fill in the TODOs, save, and watch the file turn green.
