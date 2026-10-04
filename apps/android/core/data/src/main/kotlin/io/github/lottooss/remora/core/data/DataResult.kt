package io.github.lottooss.remora.core.data

import kotlinx.coroutines.CancellationException

/** Cancellation belongs to the lifecycle, not an error card or a mutation retry. */
internal inline fun <T> dataResult(block: () -> T): Result<T> = try { Result.success(block()) }
    catch (timeout: kotlinx.coroutines.TimeoutCancellationException) { Result.failure(timeout) }
    catch (cancelled: CancellationException) { throw cancelled }
    catch (error: Exception) { Result.failure(error) }
