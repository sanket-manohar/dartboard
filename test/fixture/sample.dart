import 'package:flutter/material.dart';

/// A login bloc. Has "if (x) {" in a comment.
class LoginBloc extends Cubit<LoginState> {
  LoginBloc(this.repo) : super(const LoginState());
  final AuthRepository repo;
  final List<String> items = [];

  Future<void> login(String user, String pass) async {
    if (user.isEmpty || pass.length < 6) {
      emit(state.copyWith(error: 'Invalid {input}'));
      return;
    }
    final ok = await repo.login(user, pass);
    emit(state.copyWith(loggedIn: ok == true));
  }

  bool get isLoggedIn => state.loggedIn;

  int _score(int a) => a > 10 ? a + 1 : a - 1;
}

class LoginPage extends StatelessWidget {
  const LoginPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(children: [
        ElevatedButton(onPressed: () { print('x'); }, child: Text('Go')),
      ]),
    );
  }
}

String greet(String name) {
  return 'Hello $name';
}

extension on String {
  String shout() => toUpperCase();
}
