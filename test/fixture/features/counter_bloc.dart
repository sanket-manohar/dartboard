import 'package:bloc/bloc.dart';

sealed class CounterEvent {}
final class Increment extends CounterEvent {}
final class Decrement extends CounterEvent {}
final class Reset extends CounterEvent {}

sealed class CounterState {}
final class CounterInitial extends CounterState {}
final class CounterValue extends CounterState { CounterValue(this.n); final int n; }
final class CounterError extends CounterState {}

class CounterBloc extends Bloc<CounterEvent, CounterState> {
  CounterBloc() : super(CounterInitial()) {
    on<Increment>((event, emit) {
      emit(CounterValue(1));
    });
    on<Decrement>((event, emit) {
      emit(CounterError());
    });
  }
}

class Settings extends ChangeNotifier {
  bool dark = false;
  void toggle() {
    dark = !dark;
    notifyListeners();
  }
  void reset() { dark = false; notifyListeners(); }
}
